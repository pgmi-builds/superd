# DASHR 插件开发知识库（机制速查 + host/client 双半实操）

> **2026-09-06 蒸馏回写**：本文完整收编 `.agents/skills/dsh-plugin-development/`（`SKILL.md` + `references/core-framework.md` + `references/web-ui.md`，行级保留全部信息），
> 按 owner 裁决该 skill 属删除对象，**skill 删除后本文为机制速查的唯一文档入口**。
> 机制结论的**完整论证与源码取证**见 `../01-cordis-runtime/cordis-customization-and-override-mechanics.md`（2026-09-05，alpha.5 复核版）
> 与其 §9 勘误表——**本文与之一致，skill 原文的过时表述按勘误表已改正**（§4 列出改动点）。
> 配套研究：`../02-dsh-webui/dsh-web-ui-slot-system-research.md`（slot 机制）、`../02-dsh-webui/dsh-webui-strip-boundary-research.md`（交付链/wire）；
> 实测对照：`../../50_test-reports/v0.2.1f-plugin-shipped-ui-patches实测报告.md`、`v0.2.1ef-dev-audit-report.md`。

上游 dsh = vendored cordis 框架 + ~220 个 `@deepseek-ai/*` 包的插件宇宙。本文 = dashr（better-dsh）插件开发的操作知识：core（cordis 内核 + loader/patch 线 + host 半）+ web-ui（client 半：模块系统、slot 注册表、boot graph、覆盖机制）。
先读根目录 `AGENTS.md`（repo 拓扑与 dev/test 约定，含解析分层①→④、供应链年龄门、4999 实例循环）；构建/测试循环细节见其 Dev/Test 1 节。

---

## 0. 一分钟决策树（"我想改/加一个行为"）

| 想要什么 | 正道 | 依据 |
|---|---|---|
| 改某插件的行为参数（preset/feature/setting） | `cordis.patch.yml` 行覆盖（按 id，逐顶层键/整值 config） | 行 schema + 层序；§2.2 |
| 加一个 host 能力（工具/服务） | 插件 `apply(ctx)` + `ctx.provide` / `ctx.effect` | §2.3 |
| 加一个 Web UI 面（设置行/卡片/面板） | client 半 `ctx.slots.register`（`dsh.client` 声明） | §3.4；FailoverRow 先例 |
| 遮蔽原生 UI 组件 | 同 cell（槽/key/id）以**更低 priority** 注册（升序排列，lowest renders） | §3.4；同优先级才硬错 |
| 替换整个原生插件 | patch 行按 id 覆盖 + `name` 重指（fork/路径；`name` diff → replace 分支重新 import） | §2.2；记录未用过 |
| 同名包遮蔽原生模块 | **不可行** —— 模块表双侧硬错（client duplicate graph entry / host reconcilePackage "remove one entry"）；`@deepseek-ai` scope 归上游 | §3.3 |
| 兄弟插件遮蔽原生 service | **不可行** —— 同 scope 重复 provide 硬错；closest-wins 仅祖先链/isolate 内 | §2.4 |

## 1. 硬性边界（源码核验，勿凭直觉）

1. **无 last-wins**：模块表重复 id、同 scope 重复 provide、同 cell 同 priority —— 全部加载期硬错。dsh 组合面 fail-loud，不静默覆盖。
2. **patch 覆盖是逐顶层键覆盖，不是 merge**：`config` 是一个顶层键 → 整值替换、非 deep-merge。官方 "restate every key" 是保守 authoring 规则（机制允许只写个别键，如 dashr compaction 的 `disabled: false` 两键覆盖）。上游行形状变了 → 我们的重述要跟（对齐轮查表项）。
3. **`!!js` 能力**：boot 求值（`with(ctx) eval`，无沙箱），可读 `process.env` 与 loader 上下文服务/裸标识符（`dshHomePath('sessions')` 先例；`ctx.webRuntime.trustedHosts` 先例）；**表达式不能以 `[` 开头**（否则 YAML 按 flow-seq 拒收，用 `(…).concat(…)` 形式）；求值时机 = 该行自己 fiber 的 config 解析时（懒求值）。行级 `disabled: !!js <bool>` 亦支持。
4. **CSS 注入是一等公民**：client 工厂执行期注入的 `<style>` 被 `claimStyles` 按插件认领（`data-plugin` / `data-plugin-css`，HMR 记账）。

## 2. Core Framework（cordis 内核 + loader/patch 线 + host 半）

源码锚点均为 upstream checkout（`~/workspaces/dashr/upstream/deepseek-harness`，当前 `dsh-v0.1.2-alpha.5`）。vendored cordis 在 `vendor/cordis/src/`（含本地增强，见 `vendor/README.md`）。

### 2.1 cordis 组合模型（服务 + fiber + registry）

- **插件形态**（`vendor/cordis/src/registry.ts`）：function `(ctx, config)` / class / `{ apply }` object。静态元数据：`name`、`Config`（Standard Schema 校验）、`inject`（服务依赖）、`provide`、`intercept`。
- **Registry 按 callback 身份键控**（`RegistryService._internal: Map<Function, Runtime>`）——同一插件可多处挂 fiber，共享 runtime 记录。
- **fiber = 一次挂载的生命周期**；`ctx.effect(fn, label)` 注册 disposal；fiber 卸载时连带撤服务/监听。
- **inject 声明式依赖**：服务到位才加载，服务替换自动重跑（`ReflectService.notify` → `fiber._refresh()`）。array 形式无拦截；object 形式 `inject: { svc: interceptConfig }` 给该插件上下文的服务拦截配置。
- **事件**：`ctx.on/emit/waterfall/bail`；`internal/get`、`internal/set`、`internal/service`、`internal/plugin` 是框架内部事件面（waterfall 的 `internal/get` 可短路全局 service 解析——真实后门，无稳定性承诺，勿用）。

### 2.2 loader 与 cordis.patch.yml（声明式组合/patch 线）

- **行 schema**（`vendor/loader/src/config/entry.ts` `EntryOptions`）：`{ id, name, config, inject, disabled, group }`。
  - `id`：所在 entry tree 内稳定的行标识（patch 按 id 定位）。
  - `name`：模块说明符（包名或 `./path` / `file:` / 绝对路径）。**改 `name` 触发重新 import**（`Entry.update` 对 `name`/`inject`/`group` diff 走 replace 分支）→ 这是"整插件替换"的正规入口。
  - `disabled` 支持 `!!js` 表达式（对 loader 上下文求值）。**无 delete/exclude 形态**，删除等价物 = `disabled: true`；unmatched id = warn 跳过非 fail。
- **层序**（`packages/boot/app-boot/src/profile.ts` + `docs/user/develop/basic/publish.md`）：空表依次应用 → profile `dsh.profile.bundles` 列序的各 bundle patch → profile 级 `cordis.patch.yml` → home 级 `$DSH_HOME/cordis.patch.yml` → argv `--patch` overlay。
  - 后面的层可按 id 覆盖前面层的行。精确机制（`vendor/include/src/index.ts` `applyEntryPatches`）：**逐顶层键覆盖**（`target[key] = value`）。覆盖可带 `name` 作守卫（不匹配 = warn 跳过）。官方先例：`dsh-web-app` 覆盖 `dsh-base` 行；dashr 的 compaction 三行 re-enable。
  - **用户层 > 插件 bundle 层（用户永远赢）**。同列表内后 patch 可 target 先前 patch insert 的行（insert 后立即入 id 索引）。
- **`!!js` 表达式**：见 §1 第 3 条（boot 求值/`[` 开头拒收/懒求值/`disabled: !!js`）。
- **插件随发自己的层**：package.json `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` + `files` 含该文件。better-dsh 列在 profile bundles 末位 → 层序天然胜过 base/web-app。

### 2.3 host 半开发要点（Node 侧，dashr 的主战场）

- 入口 `src/index.ts`：`export const name/inject/Config` + `export function apply(ctx, config)`。schema 用 `@deepseek-ai/schemastery`（`z.object({...})`，default 即文档）。
- 服务：`ctx.provide('svcName', handle)`（同 scope 重复 = 硬错）；消费方 `inject: ['svcName']`。带 Config 校验的服务见 `Context.service` 模式。
- HTTP 面：`ctx.webServer.register({ kind: 'prefix', path, handler })`（`dsh-host-webserver`）。
- 工具注册、presets、settings 全是"谁提供 config 面、谁消费"的服务组合——因此**全部 patch-线可达**（§2.2）。
- **解析分层**（部署拓扑，AGENTS.md §一）：插件嵌套 ① ← profile ② ← 全 symlink ③ ← 全局 ④。host 的 `@deepseek-ai/*` 依赖全部由 ②③ 供给（14/14 实证）；① 只放真实 dependencies（schemastery/cosmokit）。
- **信任栅栏**（`packages/client/connection/src/`）：`/api` 的 Host/Origin fence = loopback ∪ `trustedHosts`（行 config，`assertTrustedAuthority` 加载期 fail-loud）∪ **LAN literals**（全接口 bind 时 web-app bundle 的 `resolveLanTrust` 派生，经 `webRuntime` 服务进 `!!js`）。CLI `--trusted-host` 即此链入口。

### 2.4 service 解析的确切语义（"closest wins" 边界）

`vendor/cordis/src/reflect.ts` `ReflectService.handler.get`：

- 从**消费 fiber** 沿 `fiber.parent` 链上行找 `fiber.store[prop]`——最近的祖先 provider 胜出（closest wins 的真实含义）。
- 跨 isolate 边界（`fiber.parent[symbols.isolate][prop] !== key`）即停止。
- 同 scope 重复 provide：`service "x" has been registered at <fiber>` **硬错**。
- 结论：**兄弟插件之间不存在 service 遮蔽**。可用的遮蔽位 = (i) 成为目标消费者的祖先（把消费者挂在自己子树里——组合权在 profile/patch 层手里，不在插件手里）；(ii) isolate scope 内自我遮蔽（只影响自己子树）。插件想"替换"原生服务 → 走 patch 行替换整个提供者插件（§2.2），而不是同名 provide。

### 2.5 发布形态

- `files` + `exports`（host 入口 `.`、client 入口 `./client`、types）；`dsh.bundle.patch` 声明组合层；`dsh.client` 声明见 §3.1。
- 供应链年龄门：pnpm 11.7 `minimumReleaseAge` —— 升级用精确版本 add，勿信 `@latest`（AGENTS.md §一）。
- kernel 预置三阶梯（postinstall / daemon spin-up / 首用 lazy）全 fail-open——host 半"不阻断宿主"的范本（`dashr/src/kernel-env.ts` + `scripts/kernel-provision.mjs`）。

## 3. Web UI（client 半：模块系统 + slot 注册表 + 覆盖机制）

双半插件：host 半空 `apply()`（给 loader 一个可加载体）+ browser 半真逻辑（`src/client/`，经 `exports['./client']` 暴露）。浏览器里 `dsh-cordis-client-runner` 再起一套 cordis，逐插件跑 client 半。

### 3.1 交付链（dsh.client → boot graph → /plugins）

- **声明**（package.json）：`"dsh": { "client": { "platform": "web", "inject": [...], "external": [...], "immediately": bool } }`。
- **host 侧**（`packages/client/modules/src/index.ts`，服务 `clientModules` / `ClientModuleRegistry`）：
  - 监听 loader 条目变化 → 解析条目包的 `exports['./client']` → 读 bundle 字节 → 并入 boot graph（行 id = 包名，rev = 内容 hash）。
  - 服务路由 `/plugins/<pkg>/client.js&rev=…`（immutable cache）；批量 combo batch 按 phase（bootstrap/application）合并。
  - `webserver/index-inject` 注入：queue script（`window.__ModuleLoader__`）+ application preload + bootstrap script + `__DSH_BOOT__` graph global。
- **构建**：`tsx scripts/build-client.ts`（monorepo 副本内**直跑**，勿 `npm run build-client`——npm pre-script 的 workspace 枚举会死于 vendor ENOTDIR）；产出 closure-factory 形 `lib/client/index.js`（`window.__ModuleLoader__.load({id, factory})`）。
- **验证**（对齐轮 S7 已固化）：鉴权拉 shell 页 → boot graph 含 `"id":"better-dsh"` 与 `/plugins/??better-dsh/client.js&rev=…` → curl 该 URL 200 且与 `lib/client/index.js` 字节一致。

### 3.2 浏览器模块系统（`packages/client/modules/src/client/system.ts`）

- 惰性 CJS 模型：seed（平台静态：react、cordis 等）→ loadCache（已物化）→ factories（已注册未物化）。`require` 走 `makeRequire`，miss 即 throw（"bundle purity gate 的运行时镜像"）。
- 物化 = 工厂执行；工厂执行期注入的 `<style>` 被 `claimStyles` 按插件认领 → **插件注入 CSS 是设计内行为**（§1.4）。
- HMR：`invalidate(id, rev)` 清 factory/cache → 重 arrive。`dsh-client-hmr` 走 `/plugins/events`。

### 3.3 同 id 覆盖 = 硬错（无 last-wins）

- client 侧：graph 行重复 → `duplicate graph entry "<id>"` throw；factory 重复注册 → throw。
- host 侧（`reconcilePackage`）：同包名从多个活跃 loader source 解析 → `remove one entry` throw。
- **同名包遮蔽原生模块不可行**：`@deepseek-ai` scope 归上游；且解析按"行 name → loader ESM resolution（baseUrl = 所属 entry tree）"走——行的代码来源由解析决定，行本身由 patch 层决定（想换实现 → patch 行 name 重指，见 §2.2）。

### 3.4 slot 注册表（组合面 + 官方遮蔽）

`packages/client/ui-slots/src/index.ts`（`SlotCore`，框架无关；`SlotRegistry` 是 cordis 包装）：

- **SlotMap 类型合并**：各插件 `declare module '@deepseek-ai/dsh-client-ui-slots' { interface SlotMap {...} }` 声明插槽契约（编译期检查）。
- **kind × scope**：`single | list | keyed | chain` × `root | session-maybe | session`。
- **register 语义**（关键）：
  - 未声明的槽 register → throw；children 重复声明 → throw（one declarer per slot）。
  - **同 cell（single=槽本身 / keyed=同 key / list=同 id）不同 priority 共存，升序排列，lowest renders**；
  - 同 cell **同 priority**（默认 0）→ throw，报错信息明示 "register at a different priority to shadow it"。
  - → **官方 UI 组件遮蔽 = 以更低 priority 注册同 cell**。dispose 撤贡献并级联塌陷 children。
- **props 五份额**：owner 分享（PropsRuntime）+ render 分享（子槽 renderSlot）+ store hooks（`use<Name>`）+ locale（t）+ inject 工厂。状态 = 框架无关 observable → `useSyncExternalStore`。
- 整个 React 树 = `renderSlot('root')` 一个入口（`ui-renderer`）；React 只是"当前安装的渲染器"。

### 3.5 布局与手势（上游事实，P3 落点的依据）

- `ui-layout`：三列 AppFrame，**内联** `gridTemplateColumns: <sidebar>px minmax(0,1fr) <details>px`（`columns.ts` 纯函数 concession 链）；框架 div 语义属性 `data-sidebar-collapsed` / `data-details-collapsed` / `data-dragging`。
- 常量：`SIDEBAR_AUTO_COLLAPSE=1024`（窄视口自动折叠）、`SIDEBAR_COLLAPSED=56`（折叠 = rail，**永不为 0**）、`CENTER_MIN=640` → 视口 <920 时 details 必然自动关。
- 窄视口 toggle 语义：翻 `narrowExpanded`（overlay 再展开），不动宽度偏好。
- `ctx.layout`（`LayoutController`）：`toggleSidebar()/openDetails()/closeDetails()` —— 跨插件面板动作面。
- **上游无任何滑动手势代码**（client UI 全包 grep 证实）→ 手势是插件纯增量。
- CSS 覆盖内联样式需 `!important`；挂语义属性选择器（随上游 DOM 演进存活率最高）；破时退化 = 原生 rail 复现（benign）。

### 3.6 浏览器侧信任事实（P2 关联 + 历史缺口）

- `ctx.connection.isLoopback` = 页面权威 loopback ∨ transport ownsHost ∨ 非浏览器（`packages/client/connection/src/client/index.ts`）。**不再阻断请求**（fence 已服务端化），但门控：`ui-settings` describe mirror 持久化 host↔memory（non-loopback = memory = **terminally unavailable, never touches the wire** → Settings/Models 页必败，报 `settings are unavailable in this browser`）、`ui-settings-general` document controller、`ui-deliverables` 徽章。
- **历史缺口（当年源码 patch 存在的全部理由；定性 2026-09-03）**：服务端 fence 认得 `trustedHosts`（operator 声明的权威），浏览器侧 `isLoopback` 只认 loopback 字符串——trustedHosts 概念**未传导**到 host facts。**定性（上游设计笔记实证）**：有意为之的只有"非 loopback 页面关掉 Host 持久化"——`.agents/notes/implemented/bug-fix/2026-08-06-host-backed-web-preferences.md` 原文 "The Client keeps Host persistence disabled on non-loopback pages, so their **preferences remain process-local** even though Connection authenticates the complete API"（设计意图 = 偏好进程本地、**页面照常工作**）；而 describe mirror（08-17 后加）把 `'memory'` 实现成 **terminally unavailable、连读都不做**——把"不持久化"过度收紧成"不可用"，describe 依赖面（Models join / plugin 目录 tab / permission row / preset writability）remote 全瘫是**无人设计过的实现产物**，不是设计决策。佐证：`'settings are unavailable in this browser'` 是 store.ts 硬编码 fallback（locales.ts 0 命中、未本地化），同页的 `loadFailed` 却是双语文案。⚠ 上游关闭所有 PR——"给上游提 PR"永久否决，勿再建议。
- **插件补偿正解（B 机制，已源码验证）**：host 半监听公共事件 `webserver/index-inject`（`packages/host/webserver/src/index.ts:34`，每次 index 渲染 emit、行数据 emit 时新鲜读取），push `{ kind: 'script', placement: 'head', text }` 内联脚本（client-modules 的 queue script 即此形状）：`location.hostname ∈ 插件 config.trustedPageAuthorities` 时设 `window.__DSH_TRANSPORT__ = { ownsHost: true }`。head 内联脚本**早于一切 application bundle 物化** → 无时序竞争；对象不带 fetch/openStream → `createWebConnectionRpc(undefined, undefined)` 走默认传输——**唯一效应是 isLoopback 翻真**（ownsHost 全仓单消费点；`isLoopback` 在 connection client `apply()` 时**一次性计算**，非逐调用重读——`client/index.ts:228`）。语义 = trustedHosts 的浏览器侧孪生。残余风险：ownsHost 属 off-label，对齐轮盯其消费点是否新增。

### 3.7 client 半开发清单

1. `src/client/index.ts`：`export const inject = [...]` + `apply(ctx)`；`ctx.effect(() => ctx.slots.register(...), 'label')` 托管生命周期。
2. package.json：`dsh.client.inject` 列出所需原生包（模块表 graph 边）+ `exports['./client']`。
3. 构建/验证循环：改 canonical `dashr/src` → rsync 进 monorepo → `tsx scripts/build-client.ts` → 重启 4999 → S7 冒烟（§3.1 验证）。
4. 测试：`*.client.spec.ts(x)` 模式（jsdom/happy-dom + `ctx.provide` 假服务），参照 `ui-layout/tests/app-frame.client.spec.ts` 的 PointerEvent 派发写法。

## 4. 相对 skill 原文的勘误/更新注记（2026-09-06 落定）

1. **覆盖语义措辞**：skill 速查写"patch 覆盖行 = 全键重写（整行重述）"→ 按 `cordis-customization-and-override-mechanics.md` §9 勘误精确为「逐顶层键覆盖；`config` 整值替换；`name` 可作守卫」。authoring 上仍推荐保守整行重述。
2. **`{disable:[...]}` 形态不存在**：patch 无独立 `disable:` 键；排除一行 = `{ id, disabled: true }` 字段覆盖（行仍在树里：id 占用、`--dump-config` 可见、可再被 `disabled: false` 救活）。
3. 插件 bundle patch 行号 id 用**裸包名**（发布改名后为 `better-dsh`），对齐轮 S7 的 boot graph grep 以此为准。
