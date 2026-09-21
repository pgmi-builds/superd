# dsh 插件行热插拔（行开关 / HMR）与行间依赖级联 —— 机制与实证

- 日期：2026-09-22
- 性质：**机制参考**（dev doc）。回答"Plugins 页的行开关到底热不热、热到哪一层、关掉被依赖的行时依赖方会怎样"，并给出 better-dsh 六组件行的完整实证。
- 源码锚点：`~/workspaces/dashr/upstream/deepseek-harness` @ `dsh-v0.1.6-alpha.2`（vendor/cordis 为仓内 vendored 源）
- 交互对象：`~/workspaces/dashr/better-dsh`（插件包，npm `@pgmi-builds/better-dsh` v0.2.4）
- 实证环境：Dev/Test 1 实例 4988（`DSH_HOME=~/workspaces/dashr/.dsh-test`，harness 0.1.6-alpha.2 + better-dsh 0.2.4，与 prod 3080 同版）
- 同族文档：`scope-switch-route.md`（loader 行热翻转做 runtime 切换的可行性）；原始实测明细：`~/workspaces/dashr/docs/50_test-reports/2026-09-22-better-dsh组件热插拔与依赖级联实测报告.md`

## 〇、结论速览

1. **行开关是热的**：写 profile 用户层 patch 的 `{id, disabled}` → 重算根 Include → 同进程 unmount/mount，**零重启**（`ChangeResult.application = "applied"`）。
2. **热的范围只有"配置面"**：hmr 默认 `root: []`，只 watch profile patch 文件 / home patch 文件 / profile `package.json`。**改插件代码（`lib/*.js`）不热**，要重启。
3. **每个 insert 行都独立可热开关**，无例外（better-dsh 六行逐个实测通过）。
4. **行间无依赖边 ⇒ 无级联**：better-dsh 六行之间没有 cordis 服务依赖，关任一行不会影响其余行；真正的依赖边都指向 **host 服务**，不在组件之间。
5. **若真存在 inject 边**：被关掉 provider 时，消费方 **自动挂起**（跑完 disposer、撤销全部注册、fiber 落到 `PENDING` = "waiting for service"），provider 回来 **自动 `_reload()` 复活** —— 不是"留在 active 里运行时崩"。
6. **但那种 toggle 会报错**：`reconcileProfilePatches` 把重算后新出现的非 ACTIVE 条目判为 introduced failure 并 throw ⇒ 该次开关返回 `application:"failed"` + 点名 pending 的依赖方；盘上 `disabled` 已写入，运行时确已挂起。用户看到的是**明确的错误提示**，不是静默坏掉。
7. **例外**：用 `ctx.get(name)`（不声明 inject）读服务的消费方**不参与依赖计算**，provider 消失时留在 active，运行时自行降级或报错。

## 一、行开关的完整链路

```
Plugins 页 toggle
  └─ PluginManager.setPluginEnabled(entryId, enabled)          plugin-manager/src/index.ts:302
       ├─ listPlugins() 校验（readOnlyReason: management-required | unaddressable 则拒）
       ├─ writePluginEnabled(profile.patchPath, id, name, enabled)   patch.ts:14
       │    └─ yaml Document 原地改写「最后一个同 id 且 name 匹配」的行：有则改 disabled，无则追加
       │       （保留注释与其余字段；这就是"行开关"唯一落盘产物）
       └─ reload()                                              index.ts:552
            └─ reconcileProfilePatches(root, readProfilePatches(...), 'dsh', requiredIds)   app-boot/src/index.ts:251
                 ├─ entry.update({ config: {...includeConfig, patches} })  ← 根 Include 行整体换 patch 列表
                 ├─ await previousFibers[].await()  +  ctx.loader.await()
                 └─ 新出现的非 ACTIVE 条目 = introduced failure ⇒ throw
```

**判定热/冷只看一个信号**：`change()`（`index.ts:557`）里

```ts
result.application = this.ownerContext.get('hmr') !== undefined ? 'applied' : 'restart-required'
```

- `hmr` 服务在场（base bundle 的 `hmr` 行 active）→ 活体重算，`applied`。
- `hmr` 缺场（headless / sdk-app / acp-app 等 bundle 把 hmr 行 override 成 disabled）→ **patch 文件照样写**，但只在下一次 profile 启动生效，返回 `restart-required`。
- `configure()` 把整段操作包进 `hmr.runExclusive(...)`，所以热重算是串行的。

### 行可否被开关：三个 readOnlyReason

`listPlugins`（`index.ts:170`）给每行标注：

| readOnlyReason | 含义 |
|---|---|
| `management-required` | 该模块在 `protectedModules` 名单（plugin-manager、loader、include、webserver、client-modules、tools、hmr、timer、api-remotes/typert、ui-plugin-manager…），或就是 plugin-manager 自己 |
| `unaddressable` | 该 entry 在 profile patch 里找不到唯一同 id 同 name 的候选行（顶层 Include 之外的行、同 id 多条、name 不匹配） |
| （无） | 可开关；`patchId` 给出要写的行 id |

## 二、什么被 watch，什么不被 watch

`packages/bundle/base/cordis.patch.yml:28-32` 给 hmr 行配的是：

```yaml
- id: hmr
  name: '@deepseek-ai/dsh-hmr'
  disabled: !!js "!ctx.get('profileContext')"
  config:
    root: []
```

注释原文 "Profile configuration reloads by default; module roots are opt-in."；`HmrConfig` JSDoc："an empty list leaves only explicit configuration watches"。

| 面 | 是否热 | 依据 |
|---|---|---|
| profile patch 文件（`.dsh-test/profiles/web/cordis.patch.yml`） | ✅ 手改也热 | `hmr/src/index.ts:215` 的 `patchFiles` 精确路径 watch |
| home patch 文件（`$DSH_HOME/cordis.patch.yml`） | ✅ | 同上 |
| profile `package.json`（bundles 列表） | ✅（仅当 bundles 变化） | `refresh(manifestOnly=true)` 比对 |
| **插件模块代码 `lib/*.js`** | ❌ **要重启** | `root: []`，模块 watch 是 opt-in |
| client bundle | ⚠️ 另一条链 | `client-hmr` 是 host 侧 500ms stat-poll 每个 graph 行的 bundle + SSE `rebuilt`；**行开关不碰 client bundle**，它的更新来自重建产物（`dev:web` 之类） |

推论：**行开关 = 配置面能力**。改 better-dsh 的源码行为，行开关救不了你，必须重启 profile。

## 三、"组件"的定义与行结构

- 页面上的组件 = bundle patch 的 **insert 行**（`declaredRows()`，`plugin-manager/src/index.ts:447`）；非 insert 行只进 `overrides`，页面既不列也不可单独开关。
- patch 层序：bundles（列序）→ profile → home → `--patch`；后层按 id **整行重述**覆盖前层（非 merge）。
- 因此"关掉某行"= 在 profile 用户层追加/改写一条 `{id, disabled: true}`；由于 profile 层在 bundle 层之后，**它总能压过 bundle 自己的 insert**。
- 开关的**持久形态是覆盖行而非删除**：重新打开会写 `disabled: false`（行保留）。想彻底移除该覆盖行得手工编辑 patch 文件。

## 四、worked example：better-dsh 六组件行

`better-dsh/cordis.patch.yml:19` 起 6 条 insert（+ 4 条 override 行：`compaction-basic`/`command-compact`/`tool-result-pruner`（再启用）与 `connection`（信任栅栏），**不是组件**，不可开关）：

| 行 id | 模块 | 静态 inject | 行内动态 inject |
|---|---|---|---|
| `dashr-repl` | `better-dsh` | `['tools']`（`src/index.ts:132`） | `['replRuntime']`（自提供自消费，行内边） |
| `dashr-url-schemes` | `better-dsh/url-schemes` | `['tools','fs','skills','subagents','sessions','settings','agents','sessionPersistence']`（`src/url-schemes/index.ts:78`） | — |
| `dashr-failover` | `better-dsh/failover` | `[]`（`src/failover/index.ts:43`） | `['settings']` |
| `dashr-compaction-tuning` | `better-dsh/compaction-tuning` | `[]`（`src/compaction/index.ts:56`） | `['settings']` / `['compaction']` |
| `dashr-web-trust` | `better-dsh/web-trust` | `[]`（`src/web-trust.ts:180`） | `['webServer']` |
| `dashr-mobile` | `better-dsh/mobile` | `[]`（`src/mobile/plugin.ts:29`） | `['webServer']` |

**关键性质：六行的 inject 全部指向 host 服务，没有一行 inject 另一行提供的服务。** 全包 `grep provide(` 无命中；唯一被提供的服务 `replRuntime` 由核心行自己 `ctx.plugin(DashrRuntime)` 注册（`src/index.ts:966`），并由**同一行**的 `ctx.inject(['replRuntime'])`（`src/index.ts:997`）消费——是行内边，随行一起销毁/重建。

唯一的跨组件耦合是**模块级单例** `src/native-capture.ts`（capture-before-mask）：核心行的 wire mask 监听器第一步自己调 `captureAllTools`，所以 url-schemes 行缺席也照常；反向亦然。这是共享 ESM chunk，**不是 cordis 服务边**，不参与 fiber 依赖计算。

各组件关闭后的降级（设计内、fail-open）：url-schemes 关 → read/write/grep/glob 回落原生语义；failover / compaction-tuning 关 → 其 client 设置卡仍在但无消费者；mobile / web-trust 关 → 页面全局缺席，客户端惰性休眠。

## 五、依赖级联：通用语义

### 5.1 有 inject 边 → 自动挂起 / 自动复活

Cordis fiber 的依赖模型（`vendor/cordis/src/fiber.ts`）：

- `_refresh()`（`:611`）用"每个 inject 服务提供者 fiber 的 uid 串"算消费方的 epoch；
- provider 注销时 `reflect` 删 impl 并 `notify`（`vendor/cordis/src/reflect.ts:277`、`:314`）→ 各依赖 fiber `_refresh()`；
- epoch 失效 → `_setEpoch()`（`:625`）调 **`_unload()`**（`:675`）：跑完该 fiber **全部 disposer**、撤销其全部注册（工具 / 事件 / slot / 服务），状态落 **`PENDING`**；
- provider 回来 → epoch 有效 → **`_reload()`**（`:646`）重跑 plugin `apply`。

诊断文本：启动/重算期是 `pending (waiting for service(s): X)`（`packages/boot/app-boot/src/index.ts:795`、`:826`），preset 挂载审计里是 `<id> (<name>): waiting for X`（`packages/preset/agent-presets/src/mount.ts:322`）。

**结论：消费方是"自动关（挂起）+ provider 回来自动开"，不是留在 active 里等到调用时才崩。**

### 5.2 但那次 toggle 会返回 failed（本次新发现）

`reconcileProfilePatches` 在重算后收集 `inactiveEntries`（遍历**全部** loader 条目、非 ACTIVE 即计入，`app-boot/src/index.ts:769`），凡不在"重算前失败集合"里的新失败即 `introduced`，直接 throw（`:268`）。于是：

- 关掉一个**被依赖**的行 → 依赖方由 ACTIVE 变 PENDING → 被算作 introduced failure → `reload()` 抛错 → `change()` 把它折成 `ChangeResult.application = "failed"` + `error.diagnostic`（点名 pending 的依赖方）。
- **盘上的 `disabled: true` 已经写入，运行时也确实已挂起依赖方**——即"操作生效但报了错"。

所以用户视角是：**开关报错 + 被依赖行变 pending**，而不是静默坏掉。（这也解释了为什么 `setPluginEnabled` 还有个 `'overridden'` 返回：若 reload 后该行的 enabled 仍与期望不符——被更高层 patch 覆盖——会额外标注。）

### 5.3 例外：`ctx.get()` 不建边

不声明 inject、用 `ctx.get(name)` 取服务的消费方**不在依赖图里**：provider 消失它照样 ACTIVE，行为由自己决定（降级/忽略/调用时报错）。本仓实例：

- `better-dsh/src/compaction/index.ts:116`/`:151` 的 `ctx.get('llm')` / `ctx.get('compaction')` —— 无边降级；
- plugin-manager 自己 `ctx.get('hmr')` —— 纯探测，缺 hmr 就退回 `restart-required`；
- 上游约定同款：`packages/AGENTS.md` "Optional services use `ctx.get(name)`. Reserve `ctx.<name>` for declared injections."

**设计含义**：想让"关掉 A 就自动带走 B"，就用 inject 声明边（代价是那次开关会报错）；想"缺 A 也让 B 活着并自行降级"，就用 `ctx.get`（代价是 B 可能带着半个功能继续跑）。二者不能靠 UI 配置切换，是插件源码的选择。

## 六、实证（4988，2026-09-22）

方法：`plugin_manager set_plugin` 逐行 off → 读 `list_plugins`（`enabled` / `fiberPhase`）→ on → 复读；boot script 行另以 `curl -c jar -L <token-url>` 拉 served HTML 数标记。全程 `ChangeResult.application` 均为 `"applied"`，**零重启**。

| 行 | off 后 fiberPhase | on 后 | 探针 |
|---|---|---|---|
| `dashr-mobile` | `null` | `active` | `__DASHR_MOBILE__` 2→0→2、`zoomGuard` 2→0→2、`ios-zoom-font-floor` 1→0→1；`__DSH_TRANSPORT__` 恒 1（不牵连另一腿） |
| `dashr-web-trust` | `null` | `active` | `__DSH_TRANSPORT__` 1→0→1；mobile 腿恒 2 |
| `dashr-failover` | `null` | `active` | — |
| `dashr-compaction-tuning` | `null` | `active` | — |
| `dashr-url-schemes` | `null` | `active` | off 期间 read/grep 回落原生仍可用；核心行全程 active |
| `dashr-repl` | `null` | `active` | off 时同页其余 **5 行全部保持 active**（无级联）；eval 随行卸载，重开后恢复 |

复原：`diff` 备份 vs 现文件逐字一致，served HTML 回基线，六行全 `enabled:true / active`。

## 七、边界与未验证

- **代码面不热**：改 `better-dsh/lib/*.js` 不触发 host 侧重载（hmr `root: []`）。本报告未实测该路径；需要热的话得给 hmr 行显式配非空 `root`。
- **§5.2 的级联失败路径为源码推导**：本 profile 内不存在"两个都可开关、其一 inject 另一个"的行对（六组件互无边；host 侧 provider 行多为 `management-required`，关它会打断当前 session），故未做破坏性 live 验证。要做最小实验：造一对测试行（provider + `inject:[...]` 消费方）放进同一 bundle patch，关 provider 观察消费方 `fiberPhase` 与 `ChangeResult`。
- 实证在 Dev/Test 1（4988）；prod 3080 未动。
- 若日后把此文档当"行开关行为"的权威，注意行开关的**持久形态是覆盖行**：`disabled: false` 覆盖行会长期留在用户的 profile patch 里。

## 八、源码锚点索引

| 主题 | 位置（`upstream/deepseek-harness`） |
|---|---|
| 行开关服务 | `packages/boot/plugin-manager/src/index.ts:170`（listPlugins）、`:302`（setPluginEnabled）、`:321`（setBundleEnabled）、`:447`（declaredRows）、`:546`（configure/runExclusive）、`:552`（reload）、`:557`（change，application 判定） |
| patch 落盘 | `packages/boot/plugin-manager/src/patch.ts:14`（writePluginEnabled） |
| 重算与失败判定 | `packages/boot/app-boot/src/index.ts:251`（reconcileProfilePatches）、`:268`（introduced throw）、`:769`（inactiveEntries）、`:795`/`:826`（pending 诊断） |
| hmr 行为 | `packages/boot/hmr/src/index.ts:215`（patchFiles 精确 watch）、`packages/boot/hmr/src/watch-config.ts` |
| hmr 默认配置 | `packages/bundle/base/cordis.patch.yml:28-32`（`root: []`） |
| client 热更新 | `packages/client/hmr/src/index.ts`（500ms stat-poll + SSE） |
| cordis 依赖语义 | `vendor/cordis/src/fiber.ts:611`（_refresh）、`:625`（_setEpoch）、`:646`（_reload）、`:675`（_unload）；`vendor/cordis/src/reflect.ts:277`（provide）、`:314`（notify） |
