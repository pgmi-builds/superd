# Cordis 定制与替代机制全景（源码取证版）

> 记录：2026-09-05 · 一手核验：`~/workspaces/dashr/upstream/deepseek-harness`（tag `dsh-v0.1.2-alpha.5`）
> vendored cordis（`vendor/cordis|loader|include|hmr|group`）+ `packages/boot/app-boot` + `packages/client/*`（ui-slots/ui-renderer/ui-theme/ui-layout/store/modules/web）+ `packages/host/webserver` + 官方 `docs/user/develop/*`。
> 本文是 `cordis-research.md`（框架理论）与 `dsh-cordis-hotplug-mcp-patch-research.md`（热插拔实测）之后的第三篇：**回答"不 patch 源码的前提下，究竟能替代/定制到什么程度、每条路的精确机制与边界"**。
> 机制速查/决策树另见 `../05-dashr-dev/plugin-development.md`（2026-09-06 自 ws skill 蒸馏入文档；本文是其完整论证底稿，多处勘误/精化已回写）。

---

## 0. 结论速查（每个问题的短答案）

| 问题 | 答案 |
|---|---|
| 自举靠 YAML 还是参数？ | **两者都是，但主体是声明式的层序 patch**：`dsh --profile <name>`（参数）定位 profile 目录 → `dsh.profile.bundles` 列表（package.json）→ 每层 bundle 的 `cordis.patch.yml` → profile/home 级 `cordis.patch.yml` → `--patch` overlay（argv）。**没有目录自动扫描**——bundle 列表严格来自 manifest 声明。 |
| Cordis 会自动扫描 YAML 吗？ | 启动**不扫描**（严格按 bundles 列表 + 固定路径）；运行**期** `web` profile 的用户层 patch 文件被 HMR watcher 盯住，**保存即热重组插件树**（`patchReload: live`）。 |
| 同层不同包名实现同功能，有加载优先级吗？ | **服务级没有**：兄弟插件之间不存在任何服务遮蔽，同 scope 同名 service = 硬错，谁"生效"取决于**消费者 inject 谁的服务名**。但 dsh 有一条流水线的两个"后者胜"相位（§3.0：patch 行级在组合期、服务级在解析期）：**行级**（patch 层序——bundles 列表靠后的层按 id 覆盖靠前层的行；better-dsh 的 compaction re-enable 就是这条，用法正确）与服务级（fiber 祖先链 closest-wins）。行级赢的只是"这行的 config/disabled 长什么样"，不改变服务解析规则。 |
| 必须注册在"下一层"吗？ | "就近者赢"（closest wins）**不是层序概念**，是 **fiber 树祖先链概念**：消费者沿 `fiber.parent` 链上行找最近 provider。让自己成为消费者的"祖先"需要把消费者挂进自己子树——组合权在 profile/patch 层手里，不在插件手里。对同 scope 的兄弟：不可行。**"同服务名多实例"的正规解是 `isolate`（group 行）**，官方文档明示。 |
| 不改源码替换某上游包的运行时行为？ | 首选**patch 行按 id 覆盖 + `name` 重指**（换实现提供者）；配置面差异用 `config` 覆盖 + `!!js`；UI 组件用 slot 低 priority 遮蔽；行为面用事件（waterfall/bail）拦截；token/样式用 `ctx.theme.overrideTokens`。全清单见 §5。 |
| YAML patch 能 delete/exclude 吗？ | **没有 `delete`/`exclude` 这样的行形态或保留键**（patch 算法只有 insert 和按 id 逐键覆盖两个分支）。**排除一行的语义等价物 = `{ id: X, disabled: true }` 字段覆盖**——效果等价（该行不运行），机制不等价（行仍在树里：id 仍占用、`--dump-config` 可见、后续层可再 `disabled: false` 救活）。unmatched id = **warn 跳过**（不是 fail）。 |
| 行覆盖是"整行重述"还是 merge？ | **逐顶层键覆盖**（`target[key] = value`）；`config` 是一个键 → **整值替换、非 deep-merge**。官方文档要求"restate every key the row needs"是保守写法（实际机制允许只写 `disabled`/`config` 等个别键——dashr 的 compaction 三行 `disabled: false` 就是两键覆盖）。 |
| CSS 能怎么 patch？ | 四条官方通道：`ctx.theme.overrideTokens`（token 级、可逆、明暗双值）；client 半 `<style data-plugin>`（claimStyles 认领 + HMR 保序）；host 半 `webserver/index-inject` 的 `{kind:'style'}` 行（进 index.html head，先于一切 bundle）；语义 data 属性选择器（`[data-sidebar-collapsed]` 等）。上游**零 `@layer`**、无用户自定义 CSS 设置面。见 §7。 |
| React 可置换吗？ | **机器层为真，生态层为假**：SlotCore/store/host 面零 React，`uiRenderer` 是普通 cordis 服务（换提供者会经 dependency fiber 重挂整个应用）；但 `SlotRenderer.renderRoot` 返回 `ReactNode`、全部 40 个 stock ui-* 包注册的是 React 组件——非 React 渲染器只能携带自己的整套组件树，不能渲染任何现有 entry。 |

---

## 1. Bootstrap：从 binary 到插件树的全链

### 1.1 入口与参数面

```
dsh bin.js（薄壳，apps/cli）
 └─ parseDshArgs(argv)                    # launcher 自有 flag
     ├─ --profile <name>（或硬别名 web = --profile web）
     ├─ --patch <path>（可重复，argv 序为最终 overlay 层）
     └─ 其余参数原样透传给 app（经 cmdlineArgs 服务快照）
 └─ runProfile → boot(binName, configPath, patches, prepare)
      ├─ new Context()                    # 根容器（框架基底，非 plugin）
      ├─ ctx.provide('dshHomePath', …)    # !!js 里裸调用 dshHomePath() 的来源
      ├─ ctx.plugin(Loader) + builtins（cordis:include / cordis:group）
      ├─ mountRootInclude(configPath, patches)   # 唯一一根：{id:'include', name:'cordis:include', config:{path, patches}}
      ├─ loader.await() + assertEntriesActivated  # fail-loud 审计
      └─ 返回根 Context
```

要点（`apps/cli/src/args.ts`、`packages/boot/app-boot/src/index.ts:661-704`）：

- **alpha.5 的 `web` 子命令接受 `--patch`**（`args.ts:200`）——勘误：AGENTS.md「web 子命令不认 --patch」只对 alpha.3 成立。
- 环境输入：`loadLayeredEnv` = 继承 env > cwd `.env` > `$DSH_HOME/.env`；`DSH_*`/`PATH`/代理等 bootstrap-only 名单出现在 `.env` 即 throw。
- profile 根的 `cordis.yml` **每次启动被重写为固定空数组 `[]`**（`apps/cli/src/profile-boot.ts:100-104`）——它只是给 Loader 一个真实 include root 锚定 `baseUrl`；**全部树内容 = 传给根 Include 的 patches**，不存在 cordis.yml ↔ patch 的双向 merge。

### 1.2 配置输入全集与精确层序（低 → 高）

`composeProfile` / `allPatches`（`profile-boot.ts:156-218`）：

1. **bundle 层**：`dsh.profile.bundles` 列序，每层的 patch 文件路径**严格来自该包 `package.json` 的 `dsh.bundle.patch` 字段**（缺声明 = fail loud，`profile.ts:457-464`）。
2. **profile 层**：`$DSH_HOME/profiles/<name>/cordis.patch.yml`。
3. **home 层**：`$DSH_HOME/cordis.patch.yml`（机器级偏好，alpha.5 新增）。
4. **overlay 层**：每个 `--patch <path>`，argv 顺序。
5. **内置尾层**：`DSH_TELEMETRY_DISABLED` 非空时自动追加 `{id: 'session-telemetry-otel', disabled: true}`。

**没有目录扫描 / auto-discovery**：bundle 列表严格来自 `manifest.dsh?.profile?.bundles ?? []`（`profile.ts:451`）；插件包必须先经 `dsh plugin add`（转发 pnpm）进入 profile 依赖并追加 bundles 列表，patch 里才能 insert。

### 1.3 模块解析（行的 `name` 如何落到代码）

`EntryTree.import`（`vendor/loader/src/config/tree.ts:173-187`）：

- `cordis:` 前缀 → loader builtins（include/group）；
- 其余经 loader internal（Node ESM resolution，**baseUrl = 所属 entry tree**）——裸包名走标准 node_modules 解析（部署拓扑四层见 AGENTS.md §一），相对路径锚定 patch 文件所在目录（`anchorInsertedPluginNames`，`app-boot/src/index.ts:285-298`）。

即：**行的存在由 patch 层决定，行的代码来源由模块解析决定**——两半正交，这正是"patch 行 `name` 重指 = 整插件替换"的机制基础。

---

## 2. 行 schema 与 patch 语义（`applyEntryPatches` 逐行解读）

唯一 patch 算法在 `vendor/include/src/index.ts:110-172`（挂载与 `dsh --dump-config` 共用同一函数，dump 不可能漂移于实际启动）。

### 2.1 行字段（`EntryOptions` + isolate 增广）

```ts
{ id, name, config?, group?, disabled?, inject?,        // entry.ts:7-21
  intercept?, isolate? }                                  // isolate.ts:5-9 增广
```

- `id`：所在 entry tree 内稳定；嵌套 id = `父:子`（`EntryTree.sep = ':'`）；**缺省自动生成 8-hex 随机**（`tree.ts:95-103`）——bundle/user 层不给 id = 后续层无法 target。
- `name`：模块 specifier（包名 / `./path` / `file:` / `cordis:`）。**改 name 触发重新 import + 整插件替换**（`Entry.update` 对 name/inject/group 的 diff 走 replace 分支，带回滚）。
- `disabled`：可为布尔或 **`!!js` 表达式**（`entry.ts:104-109`，对 loader 上下文求值；上游先例：`disabled: !!js process.platform === 'win32'`）。父行 disabled 级联禁用全部后代；group 行本身永不禁用。

### 2.2 patch 形态全集

patch 文件是 **YAML 顶层数组**，每项一个 patch：

| 形态 | 写法 | 语义 |
|---|---|---|
| 追加行 | `- insert: [{id, name, config…}, …]` | push 到树根 |
| 插入 group | `- id: <group-id>` + `insert: [...]` | push 进该 group 的 children（target 必须存在且是 group，否则 warn 跳过） |
| 字段覆盖 | `- id: X` + 任意键 | **逐键赋值** `target[key] = value`（config 整值替换） |
| 禁用 | `- id: X` + `disabled: true` | 行留树不运行（唯一"删除"等价物） |
| 防误 target | 覆盖时带 `name: <期望值>` | name ≠ target.name → **warn + 跳过**（不覆盖） |

关键机制细节（源码级）：

- **同列表内后 patch 可 target 先前 insert 的行**（insert 后立即入 id 索引，`index.ts:158-164`）——所以用户层能覆盖 bundle 层刚插入的行。
- **没有 delete/exclude/remove 形态**。所有分支只有 insert 与字段覆盖。
- **unmatched id = warn 不是 fail**：经 `ctx.root.logger?.('loader').warn` 输出；文件级错误（YAML 语法错、顶层非数组）才 throw。含义：一份跨 surface 共享的 overlay 允许引用不在每棵树里的行。
- 输入不 mutate、结果 detached（`structuredClone`）——同一份 patch 反复应用（config 热重载）能干净回退。
- 覆盖语义精确表述：**逐顶层键替换**。`config` 是一个顶层键 → 整值替换非 deep-merge（官方文档原话 "replaces a targeted row's whole config rather than merging into it"）。dashr 实证：`- id: compaction-basic` + `disabled: false` 两键覆盖即可反转 web-app 的禁用；而 `connection` 行覆盖则重述了 `name`/`inject`/`config` 全部键。

### 2.3 事务与回滚（`Entry.update`，`entry.ts:172-287`）

- merge 候选 → `deepEqual` diff → 无 diff 即 no-op；
- `disabled` → dispose；
- `name|inject|group` 变更 = **全替换**（重新 import + dispose + `_start`，失败回滚重启旧 plugin，回滚失败 `AggregateError`）；
- 纯 `config` 变更 → `fiber.update(config, true)` 热更新（同样带回滚）；
- group 容器事务（`group.ts:96-141`）：`Promise.allSettled` 并发 create，任一失败 → 删新增 + 重建旧行；重复 id → `TypeError: duplicate loader entry id`。

### 2.4 `!!js` 表达式

- 定义：`!!js` YAML **scalar** tag → `{__jsExpr: string}` 节点；求值 = `new Function('ctx','expr','with(ctx){return eval(expr)}')`（`vendor/loader/src/config/utils.ts:9-16`）。
- 求值时机：**该行自己 fiber 的 config 解析时**（`internal/config` 事件，懒求值）；tree carrier（Include/Group）的 config 保持 literal。
- 可见上下文：`with(ctx)` 里的 ctx 是 cordis Context Proxy——**所有已 provide 的服务名可作裸标识符**（`dshHomePath('sessions')`、`ctx.webRuntime.trustedHosts`）；`with` 未命中的回落全局作用域（`process.env`、`process.cwd()`、`JSON`…）。
- **无沙箱**：任意 JS。信任边界 = 谁能写 patch 文件，不是技术边界。
- **YAML 解析陷阱**：表达式不能以 `[`/`{` 等 flow 指示字符开头，否则按 flow-seq/mapping 拒收——须加括号或整式加引号（`!!js "(process.env.X ?? 'y') === 'z' ? …"`）。
- 行级 `disabled: !!js <bool expr>` 同样支持。

### 2.5 热重载（HMR）

- 谁被 watch：`patchReload: 'live'` 的 profile（web + 自定义缺省）装两个 watcher——profile 级与 home 级 `cordis.patch.yml`；`startup`（acp/headless/sdk*）只在启动应用一次。
- 若树里 hmr 服务被禁（dsh-base 默认禁用），launcher 挂 **watch-only fallback**（`root: []` 的 hmr 实例，只做 config watch）。
- 保存 → 重读文件 → **全量 patch 栈重组**（fresh clone，防 insert 行引用烤死）→ 打到根 include 行 → 事务差异挂载/卸载。失败 = warn + 上一棵好树继续跑，**不崩进程**。
- 模块级 HMR（源码改动 → 只重载该插件）由 vendor/hmr 的 partialReload 提供，要求 `--expose-internals`，带失败回滚。

---

## 3. 服务解析与"就近者赢"的确切语义

### 3.0 先立坐标：一条流水线的两个相位（composition → resolution），不是两套独立机制

| | ① 行级（composition 相位，patch 层序 later-wins） | ② 服务级（resolution 相位，closest-wins） |
|---|---|---|
| 谁赢 | bundles 列表**靠后的层**，按 **id** 定位目标行 | fiber 树上**离消费者最近的祖先 provider** |
| 管什么 | 这一行**存在与否、config 值、disabled、name、挂载嵌套**（= 插件树的静态形状） | 运行时消费者读 `ctx.svc` 时**拿到哪个实例** |
| 机制 | `applyEntryPatches` 逐键覆盖（§2.2，cordis-plugin-include） | `reflect.ts` 沿 fiber 父链上行查 `store`（§3.1，cordis core） |
| 实例 | **better-dsh 的 compaction 三行 re-enable**：列在 bundles 末位 → 层序靠后 → 按 id 覆盖 web-app 写下的 `disabled: true` → 赢。官方设计内用法，代码正确 | 同一服务被多个祖先 provide 时，子树消费者拿最近的那个 |

**精确关系（修正早前"正交"的说法）**：不是两个独立机制，是**同一条流水线的两个相位、两个命名空间**——

```
patch 层（谁存在、什么 config、挂在谁下面）  ──决定──▶  fiber 树的形状
                                                        │
服务解析（运行时读 ctx.svc）              ◀──在这棵树上走──┘
```

patch 行序决定的是**树的形状**（哪些 fiber 存在、谁是谁的父）；服务解析**只在这棵树建好之后**、读服务的那一瞬间沿树行走。两个命名空间（行 id / 服务名）不相交，所以永不冲突；但因果上 ① 喂给 ②——"在下一层 patch 里注册同名服务"之所以不能遮蔽，是因为行级赢的是"行的内容"，而行的**挂载嵌套关系**（不是层序）才是 ② 认的东西。

### 3.0b 归属与术语：哪些是 Cordis 的、哪些是 DSH 的（源码包名实证）

| 机制 | 所在包（实证） | 归属 |
|---|---|---|
| Fiber / Service 基类 / provide / inject / closest-wins / isolate / 事件总线 | `vendor/cordis`（`@deepseek-ai/cordis` 4.0.2，vendored 自 cordiverse/cordis core） | **Cordis core** —— 不是 DSH 的 |
| 行 schema / `applyEntryPatches` / `!!js` / group 行 / HMR | `vendor/loader|include|group|hmr`（`@deepseek-ai/cordis-plugin-*`） | **Cordis 官方插件包**（框架家族，core 之外） |
| 层栈（bundles→profile→home→`--patch`）/ `patchReload` / profile 模板 | `packages/boot/app-boot`（DSH 自己的代码） | **DSH** |
| host/agent/preset/global 语义分层（tools scope 链等） | dsh 各业务包 | **DSH 业务层** |

即：**"服务级"不是 DSH 发明的**——Service 基类、provide/inject、fiber 链解析全在 cordis core 源码里（`vendor/cordis/src/service.ts`、`reflect.ts`、`fiber.ts`），Koishi（Cordis 前身）多年前就有。DSH 只是**重度使用**了它（tools/llm/agents 全是 cordis 服务）。反过来，"行级 patch"的**行语义**是 Cordis 的（plugin-include），**层栈**（bundles 列表、四级叠加）才是 DSH app-boot 定义的。一个不含任何服务的 Cordis App（如 input→process→output 三插件）完全成立——closest-wins 机制仍在 core 里，只是从未触发（"没用上"≠"机制不存在/属于 DSH"）。

**Fiber 祖先链的具体含义**（源码：`fiber.ts:216-223`、`registry.ts:316-330`、`entry.ts:67,296`）：`ctx.plugin(X)` 时，X 的 fiber 的 parent = **发起挂载的那个 ctx**。链就是这么来的——

```
root fiber（new Context() 造的根）
 └─ include 入口行 ── dsh-base 各行（都挂在根下：flat 树，彼此是兄弟）
      └─ group 行（若有嵌套）→ 子行挂在 group 的 fiber 下 ← 深度来自这里
           └─ 某插件 apply 里调 ctx.plugin(child) → child 的 fiber 挂在该插件 fiber 下
```

"B 沿祖先链找服务" = 先查自己 fiber 的 store → 上到挂载它的父 → 再上到 group/根，第一个 provide 该服务的祖先胜。dsh 默认树很扁平（多数行是根的直接子行），所以 closest-wins 平时没什么深度可发挥；**深度来自 group 嵌套和 ctx.plugin 嵌套**——这也是"想靠挂载关系遮蔽服务，抓手在 group 行"的机理。

### 3.1 解析算法（`vendor/cordis/src/reflect.ts:137-172`）

```ts
ctx.events.waterfall('internal/get', ctx, prop, error, () => {
  const key = target[symbols.isolate][prop]
  let fiber = (ctx[symbols.shadow] ?? ctx).fiber
  while (true) {
    const impl = fiber.store?.[prop]
    if (impl) return impl.value                    // ← 最近的祖先 provider 胜出
    if (prop in fiber.inject) throw inactive error
    if (fiber.parent[symbols.isolate][prop] !== key) throw error   // ← isolate 边界即停
    fiber = fiber.parent.fiber
  }
})
```

三个精确结论：

1. **closest wins = fiber 祖先链 proximity**，与 patch 层序无关、与兄弟注册序无关。要"遮蔽"某服务，必须成为**消费者的祖先**（把消费者挂在自己子树里）——组合权在 profile/patch 层手里，不在插件手里。
2. **同 scope 重复 provide = 硬错**：`service "x" has been registered at <fiber>`（`reflect.ts:290`）。兄弟插件之间不存在服务遮蔽。
3. **isolate 边界即停止**：跨 realm 看不见彼此的实现。

### 3.2 isolate / group：同服务名多实例的正规解

官方文档示例（`docs/user/develop/framework/service.md`）：

```yaml
- id: group-a
  name: '@deepseek-ai/cordis-plugin-group'
  group: true
  isolate: { shell: true }        # LocalRealm：本 group 私有一份 shell
  config:
    - { name: '@deepseek-ai/dsh-bash-local', config: { timeoutMs: 5000 } }
    - { name: './src/plugin-a.ts' }
- id: group-b
  …isolate: { shell: true }       # 另一份私有 shell
```

- `isolate: { svc: true }` = LocalRealm（entry 私有，symbol 后缀 `#<entry.id>`）；`isolate: { svc: 'label' }` = GlobalRealm（同 label 共享，`@label`）。
- group 行的意义（`mountRootInclude` 注释原话）：**"a group row is how a composition gives one isolate realm to a provider and its consumers together"**——provider + 它的 consumers 放进同一 group，外面的同名服务被隔开。
- 这是"替换某服务给某些消费者"的**组合层正解**：给目标消费者建一个 group，group 里 insert 你自己的 provider。
- `intercept?: Dict`：注入到依赖该服务的插件的 per-plugin config 合并层（`entry.ctx[Context.intercept]` swap）——不换实现、只改它读到的配置。

### 3.3 兄弟插件"同功能替代"为什么不存在的判定链

| 设想 | 判定 |
|---|---|
| 同层不同包名 + 同服务名 | **硬错**（同 scope duplicate provide） |
| 同层不同包名 + 不同服务名 | 消费者还是 inject 原名 → 你的服务没人用；除非上游消费者也改（不可能，无侵入） |
| "下一层"注册同名服务 | "层"是 patch 配置层序，不是 fiber 树层——patch 层序只决定**行的存在与 config**，不参与服务解析。closest wins 只认 fiber 祖先链 |
| group + isolate | ✅ 可行：把目标消费者圈进 group，group 内提供你的实现 |
| patch 行 id 覆盖 + name 重指 | ✅ 可行且是官方整插件替换入口：整行换掉原 provider |
| 工具同名（跨 scope） | ✅ **工具层独有内置遮蔽**：per-agent/per-session scope 的同名工具覆盖全局（"nearest ancestor last"）；同 scope 内同名才硬错。这是上游为「子作用域工具变体」设计的显式遮蔽面 |

---

## 4. 非侵入替代路径决策树

**"我想改/替代某个上游行为，不动它的源码"——按序尝试：**

```
1. 只是参数/预设/开关？
   → patch 行 config 覆盖（§2.2）+ !!js（§2.4）。 presets/features/settings 全是行 config。
2. 想改某个上游服务给部分消费者的视图？
   → group + isolate（§3.2）：消费者圈进 group，group 内插自己的 provider。
3. 想换掉整个上游插件（fork 其实现或重写）？
   → patch 行按 id 覆盖 + name 重指（fork 包 / file: 路径 / 本地相对路径）。
     保留原 id ⇒ 树里仍是"同一行"，消费者/后续层的 target 不变。
4. 想包装/过滤上游行为而非替换？
   → 事件面：waterfall（不调 next() = 短路；调 next() 后改写结果）、
     bail（第一个非空返回胜出）、serial（有序观察）。
     上游大量行为面以事件暴露（tools/ptc-dispatch-log、webserver/index-inject、
     agent/* 系列；dashr 的 dashr/repl-dispatch-log 即先例）。
   → 事件面：waterfall（不调 next() = 短路/否决内置行为；调 next() 前后加工）、bail/serial（首个非空返回胜出）。
     上游有意暴露的扩展点实例（全部源码锚定）：
     · agent/request waterfall（agent-loop/agent.ts:478）—— 默认空实现，插件可整体接管 LLM 调用的 provider/model/maxTokens；
     · fs/edit-intent / fs/write-intent waterfall —— 默认无条件放行，插件可返回 {version} 做 observed-guard 包住文件写路径；
     · user-questions/request waterfall —— 默认拒绝，插件注册 answerer 即接管用户提问通道；
     · tools/ptc-dispatch-log、webserver/index-inject、session-telemetry/record、loader/patch-context 等。
     判据：凡是上游以 `ctx.waterfall(name, args, default)` 形态写的地方，行为可被插件整体替换——这是本 codebase 的 middleware 模式。
   → monkey-patch：后加载插件拿到 ctx.svc 引用后改方法。无机制阻止，
     但无顺序保证、不可逆记账、升级即碎——最后手段（见 §5.3 风险）。
6. UI 组件？→ slot 低 priority 遮蔽（§6.2）。
7. 颜色/字号/字体？→ ctx.theme.overrideTokens / register（§7.1）。
8. 全页 CSS/DOM？→ index-inject style/script 行（§7.3）或 client 半 style 注入（§7.2）。
```

### 4.1 侵入式 vs 非侵入式的边界总结

- **fork 源码 patch**（侵入式）：唯一能改"未以任何面暴露"的内部逻辑的方式；代价 = 升级即丢、双侧（host+client）维护、对齐轮负担。本仓库的既定纪律（AGENTS.md）：优先走插件/patch 线，prod 不做源码级侵入。
- **pnpm overrides**（部署者级包替换）：用户侧 workspace 配置可做包名 → fork 的重指，但那是**部署者操作**，不是插件可随发的面；且浏览器模块表侧有 duplicate-id 硬错兜底（§6.4）。

---

## 5. 运行时"变量"替代手段清单（不改上游源码）

用户问题："想改变上游包的某个运行时变量（非环境变量），非侵入 patch 方式有哪些？同层/下一层就近者赢是否适用于变量层？"

**回答**：closest-wins 是**服务解析**规则，只作用于"消费者读 `ctx.svc`"这一件事；它不适用于任意运行时变量。但运行时可变面按暴露层级分七档，每档有自己的正道：

| # | 手段 | 作用域 | 机制锚点 | 可逆性 |
|---|---|---|---|---|
| 1 | **行 config 覆盖**（bundle/profile/home/overlay 层） | 该插件实例 | `applyEntryPatches` 逐键替换 | 可逆（层可撤销，live 热重载） |
| 2 | **`!!js` boot 表达式** | config 值本身 | `with(ctx) eval`，可读 env + 服务 | 同上 |
| 3 | **`ctx.theme.overrideTokens(source, tokens)`** | 全 UI token（颜色等） | `ui-theme/client/index.ts:308`，seq 序 per-token 后到胜出，明暗双值必填 | 官方可逆（disposer 撤层） |
| 4 | **事件 waterfall/bail 拦截** | 事件触发的行为面 | `ctx.on(evt, (x, next)=>…)`；不调 next() 短路；`prepend: true` 可插队 | ctx 卸载即撤 |
| 5 | **isolate group 内换 provider** | group 内消费者 | `reflect.ts` 隔离 + group 行 | patch 层可逆 |
| 6 | **inject-intercept（object 形式）** | **仅限 opt-in 读 `resolveConfig` 的服务**——本 tag 全树唯一实际消费者 = `loader.await`（依赖 loader 的插件的激活门）；不能换实现、不能改 `ctx.get` 结果 | `fiber.ts:239-244` 写入 + `service.ts:86-99` 合并（越靠近子层/head 越后应用、胜出） | patch 层可逆 |
| 7 | **monkey-patch 服务方法** | 全局（该服务实例） | 无机制阻止（JS 对象可变） | 不可逆记账、无顺序保证 |

补充判定：

- **模块级 patch**（import 同一模块实例改 exports）：loader 经 Node ESM internal 的同一 `loadCache`——同 specifier 全进程同实例，共载方拿到同一 namespace。ESM namespace 本身只读（不可重绑绑定），但**对象值的 export**（`export const obj = {}`、类静态、注册表）可变异；CJS `exports.foo` 可整体替换。仍是最脆的一条（上游一次重建对象即失效、HMR 重载即丢），不推荐。
- **`internal/get` / `internal/set` waterfall 后门——属实且比预想更宽**：reflect.ts:153 每次未命中 own/accessor 的属性读都包进 `internal/get` waterfall（fiber 链遍历只是内置 fallback）——任何插件 `ctx.on('internal/get', …)` 不调 `next` 即可**进程级短路任意服务解析**；`internal/set` 同理。另有 `internal/listener` bail（events.ts:273-275）可**替换事件监听器的注册本身**。均为 internal/* 无公开契约，无稳定性承诺，勿用。
- **monkey-patch 的精确时序保证**：vendor 全树零 `Object.freeze/preventExtensions/seal`；服务对象是普通可变对象（`ctx.set` 跨 fiber 换值才硬错，对象内部变异不受限）；消费方拿到的 `getTraceable` 代理只追踪读、底层可变。兄弟行 `Promise.allSettled` 并发 create **无严格完成序**——唯一有保证的顺序原语是**服务依赖**（inject 声明使 fiber PENDING 到依赖 ACTIVE）。「inject 目标服务 + 在 apply 里 patch 其方法」是唯一确定性的 monkey-patch 时序。
- **`Context.current` 在本 fork 不存在**（Koishi 体系概念，vendored cordis 无此静态属性）——引用外部资料时留意。

---

## 6. UI 层机制速查（store / slot / 渲染器 / 模块表）

（详细论证见 `../02-dsh-webui/dsh-web-ui-slot-system-research.md`；本节为 alpha.5 源码复核后的精化版。）

### 6.1 Store：注册侧"座位"，不是全局容器

- 引擎 = React-free `zustand/vanilla + immer + subscribeWithSelector`（`packages/client/store`）；契约层在 ui-slots（`store.ts` re-export）。
- API 面：`StoreSpec{init, persist?, actions}` → `defineStore` → `StoreHandle`；组件只拿 `useStore`（selector）+ 烘焙好的 `actions`（唯一写面，"the audit face"）。
- **创建**：在 `ctx.slots.register({name, store: handle|factory, …}, Component)` 里声明——共享 handle（同插件多注册复用）或独占工厂（每 entry×scope 一实例）。
- **贡献到别人的 store：不存在该机制**。跨插件共享状态走 observable + inject 工厂 hooks，不是写别人的 store。
- 同一 handle 挂不同 scope = 硬错（"one handle, one scope"）；session scope 死亡清实例并 `clearPersisted()`。
- Handle **不得模块级导出**（"module-cache identity is a disguised singleton across plugin reloads"）——工厂形式防单例。
- 到 React：全栈唯一 hook 构造点 `bindSnapshotSelector`（`useSyncExternalStoreWithSelector`），在渲染机器装配时绑进组件 kit。

### 6.2 Slot：声明排他 + 优先级遮蔽

- kind：`single | list | keyed | chain`；scope：`root | session-maybe | session`。
- **声明即排他**（children 表，one declarer per slot；`root` 是唯一 built-in 声明）。未声明 register → throw；重复声明 → throw。
- **同 cell 不同 priority 共存，升序排列，lowest renders**；同 cell 同 priority（默认 0）→ throw，报错原文明示 "register at a different priority to shadow it (lowest renders)"。
  → **官方 UI 组件遮蔽 = 以更低 priority 注册同 cell**。崩溃自愈：渲染抛错的 entry abdicate（退役），cell 落到下一位存活者。
- 组件 props = 五份额交集：owner props + render slots（children 声明窄化）+ store kit（useStore/actions）+ inject 工厂面（hooks 自动变 `use<Name>`）+ locale（类型化 t）。
- 实例（上游真实代码）：ui-theme 的 AppearanceRow 注册进 `settings.general.item`（list, root scope, id/order/store/locale/inject 全要素）；ui-layout 的 AppFrame 注册进 `root` 并声明四子 slot——root 上的覆盖会把 AppFrame 连子座一起顶掉，官方 JSDoc 明示**别在 root 遮蔽，去 `shell.overlay`**。

### 6.3 渲染器可置换性（诚实裁决）

- React 只存在于 ui-renderer 的 client 半 + 各 ui-* 组件本体；SlotCore（注册语义）、store 引擎、`SlotRendererHost`（hostFace 全框架中立）零 React。
- `uiRenderer` 是 `ctx.reflect.provide` 的普通服务；web boot kernel 经 `ctx.inject(['uiRenderer'], scope => scope.effect(() => scope.uiRenderer.mount(container)))` 消费——**换 uiRenderer 提供者 = dependency fiber 重挂整个应用**，接缝是设计内的（boot.ts 注释原话）。
- 但 `SlotRenderer.renderRoot(host, ownerProps): ReactNode` 的签名即 React 语义；全部 stock 组件是 React 函数组件。
- **结论**：可置换 = React 版本/fork 层面替换或外壳包装（boot script、mount 前后 DOM 干预）；框架级"换脑"（如换 Vue）意味着携带自己的整套组件树，无法渲染任何现有 entry。

### 6.4 浏览器模块表：duplicate id 双侧硬错

- wire 层 `duplicate graph entry "<id>"` throw（manifest.ts:193）+ 构造层同错（system.ts:88）+ 二次执行防呆（"bundle executed twice without invalidate?"）+ duplicate batch URL（manifest.ts:231）。注：**Node 半构建 graph 行只查环、不查重**（modules/src/index.ts:440-460）——重复 id 的兜底在浏览器半（物化前）。
- **平台 seed 永远最先**：`makeRequire` 先查 seed 表（`react`、`react-dom`、`@deepseek-ai/cordis`、store、ui-slots、ui-primitives 八个，由 shell 静态 import 播种，`web/src/platform.ts` 单一事实源）——插件 bundle 以 `'react'` 为 id 注册也遮蔽不了 seed。
- 结论不变：**同名包遮蔽 stock 模块 id 不可行**；上游 `@deepseek-ai` scope 归上游，整插件替换走 patch 行 name 重指。

---

## 7. CSS 定制面全景

### 7.1 Token 层（官方一等公民）

- 令牌 = `--dsw-*` CSS custom properties（静态色板 `--dsw-static-*` → 语义别名 `--dsw-alias-*` → 专属 `--dsw-specific-*`；13 个可检视 token 目录内建于 ui-theme）。暗/亮不是两份文件，是 `body[data-ds-dark-theme]` 属性切 palette + ThemePresenter 把 active tokens 写成 **body 内联 CSS 变量**（`body.style.setProperty`——内联级联天然压过一切 stylesheet）。
- 两条官方 API：
  - `ctx.theme.register({id, colorScheme, tokens})` —— 注册整套主题（重复 id throw；dispose 活动主题会回落默认）。
  - `ctx.theme.overrideTokens(source, {token: {light, dark}})` —— **叠覆盖层**：seq 序后到 per-token 胜出、同 source 重复调用整层替换并置顶、disposer 撤层即还原；**明暗双值必填**（裸字符串 throw 教学错误）。文档自称"token-level analogue of slot shading"。
- 字号：`ctx.theme.setFontSize(px)`（12–17 整数，写 settings 持久化）。

### 7.2 client 半 `<style data-plugin>`（claimStyles 认领 + HMR 保序）

- 插件 client 工厂执行期注入的 `<style>` 被 `claimStyles` 认领（无主标签归当前物化模块），记入模块 record 的 `styles`——**插件注入 CSS 是设计内行为**。
- HMR：旧 fiber drain → `removeOwnedStyles(id)` 按 `data-plugin` 删 → 新工厂物化按稳定 tag id 重注入（顺序保证）。
- 自挂样式的正规写法（ui-theme 同款）：`ctx.effect(() => { tag = createElement('style'); tag.dataset.plugin = …; tag.dataset.pluginCss = '<pkg>/<name>.css'; head.append(tag); return () => tag.remove() })`。
- 覆盖上游样式的现实规则：上游**零 `@layer`**——级联 = 来源顺序（head 注入顺序）→ specificity → `!important`。组件内联样式（AppFrame 的 `gridTemplateColumns`、DragHandle 的 `left`、ThemePresenter 的 body 内联变量）**必须 `!important` 才能压过**。
- 稳定 DOM 钩子：`[data-sidebar-collapsed]`、`[data-details-collapsed]`、`[data-dragging]`、`[data-side]`、`[data-shell-overlay]`、`[data-dsh-boot]`、`body[data-ds-dark-theme]`、`--dsh-content-font-size`——语义属性随上游 DOM 演进存活率最高。

### 7.3 host 半 `webserver/index-inject`（进 index.html，先于一切 bundle）

事件载荷 = 往 `table: IndexInjection[]` push 行，每次 index 渲染 fresh emit（行数据读时新鲜）。行类型全集：

```ts
{ kind: 'global', name, value }                        // globalThis[name] = value（head 内联脚本）
{ kind: 'script', placement: 'head'|'body', text }     // 内联经典脚本
{ kind: 'script-src', placement, src }                 // 外部脚本（表序执行）
{ kind: 'script-preload', src }
{ kind: 'style', text }                                // <style> 固定进 head
{ kind: 'html', placement, html }                      // 原始标记片段
```

插入位置 = `<head>`/`<body>` 开标签**紧后** → **早于一切 application bundle 物化**，无时序竞争。better-dsh 的 boot script（web-trust 腿、zoomGuard）即此通道先例；ui-theme 的 boot 主题注入亦然。逃逸口：`webServer.tapIndex(transform)` 可做行表达不了的原始 HTML 变换（行渲染之后按注册序应用）。

### 7.4 官方用户自定义 CSS 设置面：不存在

grep 全量（client+host+apps）：无 customCSS/userStyle 类设置项；设置面只有主题偏好 + 字号。**用户 CSS 的现实通道就是插件机制**（7.1–7.3）——这也是 better-dsh 类插件的生存空间。

---

## 8. 同名冲突规则总表（fail-loud vs 优先级）

| 命名空间 | 冲突行为 | 锚点 |
|---|---|---|
| cordis 服务（同 scope） | **硬错** duplicate provide；祖先链 closest-wins | `reflect.ts:290` / `:137-172` |
| loader 行 id（同树） | **硬错** duplicate loader entry id（group 事务内） | `group.ts` |
| patch id 不存在的 target | **warn 跳过**（非 fail） | `include/index.ts` |
| 浏览器模块表 id | **双侧硬错**（wire + 构造）；seed 永远最先 | `manifest.ts:193`、`system.ts:88` |
| slot cell（同优先级） | **硬错**，报错引导用不同 priority；不同 priority = lowest renders | `ui-slots/index.ts:826-848` |
| slot children 声明 | **硬错**（one declarer per slot） | `ui-slots/index.ts:851` |
| store handle 跨 scope | **硬错**（one handle, one scope） | `ui-slots/index.ts:875-881` |
| 主题 id | **硬错** already registered；overrideTokens 同 source = 整层替换（非错） | `ui-theme/client/index.ts` |
| 事件 listener | 多个共存（按模式协作：emit 广播 / bail 短路 / serial 序贯 / waterfall 链） | events.ts |
| patch 覆盖带 name guard | name 不匹配 = **warn 跳过**（防误 target 的保护，非冲突） | `include/index.ts:150-153` |
| accessor / property 声明 | **硬错** `already declared as …` | `reflect.ts:272,328` |
| `ctx.set` 跨 fiber | **硬错** `in multiple fibers` | `reflect.ts:229` |
| HTTP 路由（同 kind+path）/ upgrade / fallback | **硬错** `duplicate route` / `fallback already registered` | `host/webserver/src/index.ts:167-198` |
| **工具注册（同 scope 同名）** | **硬错**；但**跨 scope = 就近遮蔽**（"Inherited surface, nearest ancestor last"——子 scope 同名工具覆盖父 scope，这是工具层独有的内置遮蔽面） | `core/tools/src/index.ts:719,1150` |
| agent preset id | 读取 = 优先级合并（先根胜）；**写入已占 id = 硬错** | `discovery.ts:327`、`authoring.ts:44` |
| settings namespace | **硬错** already registered | `settings/src/index.ts:426` |
| locale catalog id | **硬错** already registered | `client/locale/src/client/index.ts:259` |
| ui-session provide（同 kind+name prop） | **硬错** duplicate | `ui-session/src/client/index.ts:493` |
| HMR config watch 路径重复注册 | **硬错** | `vendor/hmr/src/index.ts:139` |
**设计哲学**：dsh 的组合面几乎全部 fail-loud 无 last-wins；仅有的"优先级"机制是 slot priority（显式声明、lowest renders）与 theme override seq（显式分层）——都是**作者主动声明的组合序**，不是隐式覆盖。

---

## 9. 与既有文档的交叉引用与勘误

- `cordis-research.md`：框架理论（effect/coeffect、fiber、竞品）——本文不重复。
- `dsh-cordis-hotplug-mcp-patch-research.md`：patch 热重载实测与 MCP 插拔——本文 §2.5 补齐了其机制底座（composeLive fresh-clone 的原因、失败不崩进程的语义链）。
- `../02-dsh-webui/dsh-web-ui-slot-system-research.md`：UI 插槽系统（alpha 早期版本）——本文 §6 为 alpha.5 复核精化（priority 语义、abdicate、store seat 模型）。
- `../05-dashr-dev/plugin-development.md`（原 ws skill `.agents/skills/dsh-plugin-development/`，2026-09-06 蒸馏入文档）：速查。**勘误/精化三处**：
  1. 「整行重述（全键重写）」→ 精确为「逐顶层键覆盖；config 整值替换」；官方"restate every key"是保守 authoring 规则。
  2. `dsh-cordis-hotplug-mcp-patch-research.md` §2.1 表中的 `{disable: [...]}` 形态 → 勘误：实为 `{id, disabled: true}` 字段覆盖，无独立 `disable:` 键（源码 `applyEntryPatches` 无此分支）。
  3. AGENTS.md「web 子命令不认 --patch」对 alpha.5 不成立（`args.ts:200` 明确支持）。
- `docs/10_plans/dashr-profile-layer-feasibility.md` / `openspec/changes/2026-09-03-plugin-shipped-ui-patches/`：机制结论的应用先例。

## 10. 待深挖（后续研究的抓手）

- `internal/*` 事件面全目录（get/set/service/plugin/listener/dispatch/update）——已证实 `internal/get`/`internal/set` 可进程级短路服务解析、`internal/listener` bail 可替换监听器注册本身；无稳定性承诺，只作机制事实记录。
- `ctx.accessor` / `ctx.mixin`（reflect.ts 后半）——比 monkey-patch 更正的运行时属性扩展面，尚无插件先例。
- chain kind slot 的 select 路由实战（现仅 ui-chat 等少数使用）。
- `webServer.tapIndex` 与 index-inject 行的顺序交互（打包 worker 形态下的行为）。
- LSP/AST/graphify MCP 对上游 220 包的 override 面自动盘点（哪些包暴露事件、哪些服务有 intercept 钩子）——可做成机制目录生成器。
