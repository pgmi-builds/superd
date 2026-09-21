# M0 分叉路线：全局 Runtime Selector 与全服务面多槽化设计（单 Context 深度集成）

- **日期**: 2026-09-12
- **定位**: 架构设计文档（从 M0「键值路由器」分叉的继任路线：外来 runtime 不再自足桥接，而是**彻底融入** DSH 全服务面）
- **路径**: `docs/superpowers/plans/2026-09-12-m0-fork-global-runtime-selector.md`
- **核心命题**: **既然 integrate 一个 Agent Runtime，就把它完整 integrate 到所有 service 层面**——用一个横跨 Gateway / Remote Service / 各服务 / Session Storage 的全局 Runtime Selector，把 DSH 从「单 runtime 宿主」升级为「单 Context 内多 runtime 共存的统一入口 App」。凡通过 DSH 发起的 OMP/Codex 会话，数据面归 DSH（自有 Session Storage），原生 runtime 降级为可替换的计算引擎；数据 duplicate 被显式接受（未来用户统一走 DSH UI，旧 TUI 退役）。
- **血缘**: `docs/02-dsh/agent-runtime-provider-seam.md`（键值路由器定案）§5.4「外来 runtime 自足性」**在本路线被推翻**——自足=不融入=桥接不伦不类；其投递时路由、fiber 与观察者正交、broker 子进程托管三原则**全数继承**。M0 多槽 registry（`apps/multi-agent/dsh-multi-agent-registry`）为现成资产。
- **与 Multi-Context 路线的关系**: 互斥的哲学、不同的市场，非互斥的机制（§六）。Multi-Context = Agent Orchestration Platform（每个 runtime 一个完整世界，App 级单值 selector，世界间纯净切换）；本路线 = **单入口聚合器**（一个 App、一个数据面，runtime 是会话级属性，目录级 union、呈现级 filter）。

---

## 〇、哲学宣言：从「桥接」到「融入」

M0 原路线保留 OMP 完整生产形态（自有 session storage、自有 TUI），DSH 只做桥接层读取。实测证明这个形态两头不靠：

1. **接得浅**：OMP 会话要在 DSH UI 列出，就必须覆盖根级 `sessionPersistence` 单例（union 扫描）→ native 数据面被污染（M0 搁置直接死因）。
2. **接得散**：模型目录、presets、默认模型各自为政，切回 DSH 时处处残留。
3. **接得假**：OMP 会话的真相仍在 OMP store，DSH 只是投影——用户一旦在 OMP TUI 里动了数据，两边立刻失同步。

本路线反向裁决：**数据面真相搬进 DSH**。外来 runtime 只保留「跑 turn」的执行角色：

| 维度 | M0 桥接形态（被推翻） | 本路线（融入形态） |
|---|---|---|
| Session Storage | OMP store 为 source of truth，DSH 投影 | **DSH SessionEvent log 为 source of truth**；OMP 自有 store 退化为无消费者的 byproduct |
| Session 主键 | OMP sessionId（DSH 侧映射） | **DSH sessionId 为主键**，OMP 侧标识收进事件 metadata |
| 模型目录 | 各自目录，UI 恒 native | **union 目录**：DSH + OMP + 未来 Codex/Claude 同列呈现 |
| 呈现面 | 混流病灶 | **select/filter 切面**：每份数据带 runtime 归属，UI 按 selector 过滤 |
| LLM/凭据 | OMP 全自持 | OMP 模型经 adapter 注册进 `ctx.llm`（复用上游多槽） |

---

## 一、正交性判定：Agent Runtime ⊥ Services 到底成立到哪里

**判定：机制层正交，数据面不正交。M0 卡点不是正交性判断错误，而是只把正交化做了半边。**

用 Cordis 的模型精确表述：

1. **机制层正交（上游设计意图）**：Cordis 的 DI 里，agent（fiber 生命周期 + 运行实例）与 service（capability seam 的命名实现）是两个独立维度。官方文档钦定的「per-session capability set = agent preset + isolate realm」（ch06: *a service row there needs an isolate realm*）与 dsh-scope 的「one registration context = per-agent visibility + shared lifetime」共同证明：**「运行实例 × 服务组合」的笛卡尔积是框架设计意图**——agent 可以 compose 不同的 service world。
2. **数据面不正交（本质，非缺陷）**：`sessionPersistence` / `llm` 目录 / `agentPresets` / `sessionQuery` / model-selection 是**进程级根单例**。它们的存在意义就是「跨 agent 共享的数据面」——单机单用户 App 一个会话库、一个模型目录。单 runtime 时代这是正确的经济性；第二个 runtime 进来要求共享同一 UI/BFF 时，这些单例必须获得「按 runtime 维度分片」的能力。
3. **M0 卡点的准确病历**：键值路由器把 **`agents` 这一行**多槽化了（投递时按 `runtime` 键选 factory——正确且已实证），但 agent 的「输出物落盘」（persistence）与「目录呈现」（llm/presets/query）仍是**不分片的列**。OMP adapter 为让 UI 列出自己的会话只能 `provide('sessionPersistence', union)` 覆盖根单例 → 污染。**矩阵比喻：M0 做了一行，没做一列；全局 Selector 就是贯穿整个服务矩阵的坐标系。**

推论：全局 Selector 的职责不是「再隔离一次」，而是**把正交性从 agent 生命周期内（scope 级）上推到 BFF/数据面级（request 级）**——让根单例服务在保持「单名字、单消费 API」的同时，内部按 runtime 键分片。

---

## 二、全局 Selector 机制设计（本文档核心）

### 2.0 需求陈述

Selector 必须：

1. **贯穿全栈**：Gateway → Remote Service（SessionController 等）→ 各根服务（llm/persistence/presets/query）→ Agent Registry 全链路可见。
2. **Request 级并发安全**：不同浏览器 tab 一个在 native 会话、一个在 OMP 会话，互不可见、互不污染——**不是一个进程级全局变量**。
3. **Session 级持久**：会话归属哪个 runtime，落盘、重启可恢复。
4. **不是后端临时内存形态**：UI 的每个（需要路由的）请求都携带/蕴含 selector，后端在请求边界解析。
5. **native 路径零行为变化**：selector=native 时，一切服务解析与上游原行为逐位一致（回归红线）。

### 2.1 结论：Selector 不是单一 Cordis 原语，而是三层复合体

它确实「不像 runtime、service、scope、composition，更不是隔离 context」——因为它是**一个执行维度（dimension）**，需要三个既有机制各承一层：

```
┌─ L3 wire/持久化层：三级键解析 ──────────────────────────────┐
│   request 显式 runtime 键 > session 归属键(header) > 'native' │
│   UI chip（M1 RuntimeSeat 复用）只写前两级                      │
├─ L1 值与传播层：Ambient RuntimeKey 执行上下文 ────────────────┤
│   AsyncLocalStorage；gateway 请求边界写入；整条同步调用链可读   │
│   （同构上游 initiator scope 的 withInitiator 因果归属机制）    │
├─ L2 分派层：internal/get 拦截 + per-runtime isolate realm ───┤
│   selector 监听 cordis internal/get waterfall（reflect.ts:153）│
│   对「已多槽化名单」内的服务名按 ambient 键返回对应 realm 实现   │
│   名单外服务与 native 键 = 原样透传（零行为变化）                │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 L1 —— Ambient RuntimeKey：值与传播（为什么不是全局变量、不是 dsh-scope）

- **载体**：模块级 `AsyncLocalStorage<string>`（或同构 fiber-local 存储），`withRuntime(key, op)` 建立「本次请求处理链」的 runtime 归属——**与上游 `ctx.agents.withInitiator(agent, op)`（initiator scope，ch13）完全同构**：ambient 因果归属，进 op 前绑定、op 结束消散，天然并发安全。**initiator 的源码事实（2026-09-12 三轮验证）**：它**不是 Cordis scope 树成员**，是 agent 服务类内部两个私有 `AsyncLocalStorage`（`initiators: AsyncLocalStorage<Agent | undefined>` / `initiatorRuns`，`packages/core/agent/src/index.ts:253-254`）——重点在 **initiator（值）**而非 scope（借词）；它**不随 runtime/web server 出生**（server 出生时无任何 initiator），而是随 **agent 操作边界**进入（调用方仅 agent-loop 的 `agent.ts`/`tool-calls.ts` 与 tool-cordis `api-catalog.ts`——loop 驱动、工具调用、API 目录归属时 `withInitiator` 包裹）；**可寻址性仅一条路**：`ctx.agents.currentInitiator()/requireInitiator()` 服务方法读——不是 DI 服务名、不可注入、外部不可伪造。对我们的意义：它是「AsyncLocalStorage ambient 归属」形态在 dsh 代码库的一等公民先例（同构样板、非复用——initiator 归属 Agent 对象「谁引起的」，RuntimeKey 归属 runtime「属于哪个世界」，二者并存不冲突；写入点从 loop 执行边界推广到 gateway 请求边界）。
- **写入点（且仅此一处）**：gateway/`connection.fetch` 请求边界。每个进入的 RPC/Fetch 请求，按三级解析（L3）得出本次的 runtime 键，`withRuntime(key, () => dispatch(...))` 包住整个处理链。
- **为什么不是 dsh-scope**：dsh-scope 是 per-agent **注册可见性**分层（事件路由 + 注册视图），生命周期始于 agent 创建之后，且不做服务隔离（scope-switch-route.md §一已核实）——BFF 数据面请求发生在 agent 之前，且需要的是「寻址时分片」不是「注册时分层」。
- **为什么不是进程级单值**（M1 multi-context 路线的 `selector.ts` 形态）：那是 App 级「世界切换」模型（一个时刻一个世界），符合其纯净投影裁决；本路线是会话级共存模型，两个世界必须同时服务不同请求——**单值会被并发写踩烂**。
- **长生命周期豁免（继承投递时决策原则）**：ambient 键只在**请求处理链**内有效；活 agent 的 turn 执行、事件回调、后台任务**不依赖** ambient——agent 归属在创建/恢复时一次性解析并随 `AgentEntry` 持有（M0 registry 已如此）。路由是投递时决策，fiber 生命周期与观察者正交（provider-seam §5.3 裁决原文继承）。

### 2.3 L2 —— 分派：`internal/get` 拦截 + per-runtime isolate realm（「进驻 Context」的字面实现）

cordis 服务寻址（`ctx.get` / proxy 属性读）内建 waterfall（源码锚点：install 树 `@deepseek-ai/cordis/src/reflect.ts:153`，`ctx.events.waterfall('internal/get', ctx, prop, error, () => …)`；ch05 事件表同时列有 `internal/service` binding 拦截钩子——框架预留的扩展缝，无核心生产者占用）。**这就是「Selector 全面进驻 Context」的机制级落点，且比 multi-context V5 的实例 monkey-patch 更正统**：

```ts
// selector host 插件（示意）
const MULTISLOT: ReadonlySet<string> = new Set([
  'agents', 'sessionPersistence', 'agentPresets',
  'llmCatalog', 'modelSelection', 'sessionQuery',
])

ctx.on('internal/get', (targetCtx, name, error, next) => {
  const key = readAmbientRuntime()          // L1；请求链外 → undefined
  if (key === undefined || key === 'native' || !MULTISLOT.has(name)) {
    return next()                            // 名单外 + native + 非请求链：零干预透传
  }
  const impl = realmOf(key)?.resolve(name)   // 从该 runtime 的 isolate realm 取实现
  return impl !== undefined ? impl : next()  // realm 缺服务 → 回落 native（自愈语义）
}], { global: true })
```

> **waterfall 语义澄清（2026-09-12 问答补充）**：这里介入的不是「任意 waterfall 事件」，而是**一个特定的内部事件 `internal/get`**——cordis 把「服务寻址」这一步本身包在它的 waterfall 里（trap 源码：`ctx.events.waterfall('internal/get', ctx, prop, error, () => { 沿 isolate 键 + fiber 链查 fiber.store })`，`next()` 的默认实现就是原生解析）。waterfall 不是无序广播，是**同步包裹链**：唯一的 selector 监听器要么调 `next()` 放行原生解析、要么不调 `next` 直接返回 realm 实现（即拦截）。时序上不存在「某服务已按旧 key 执行、后续服务才按新 key」的撕裂——ambient key 在请求入口由 `withRuntime` 设定，整个请求处理链期间恒定；单次寻址的 waterfall 同步完成。跨请求的长活 agent 不依赖 ambient（投递时决策，§2.2）。
}, { global: true })
```

- **per-runtime isolate realm**：每个 foreign runtime 的服务实现群（ompPersistence、ompPresets…）住进 `ctx.isolate('runtime-omp', label)` 子树——上游钦定的「同名服务不同实现」机制（ch05：*isolate when two subtrees need different implementations of one service name*；同 label 可并域）。selector 持 `runtimeKey → isolate ctx` 表；`realmOf(key).resolve(name)` 即在对应 isolate 域内做同名解析。
- **消费面零改动**是本机制的决定性优势：`sessionPersistence` 的消费包（agent-loop、message-feedback、schedule、session-checkpoint-policy 等——grep 实证）照常访问 `ctx.sessionPersistence`，拿到的是**当前请求维度**的实现切片。上游消费者、上游服务定义、上游 wire 契约都不动。
- **拦截覆盖面（2026-09-12 二轮源码验证，精确边界）**：cordis proxy 的 get trap（`reflect.ts` `handler.get`）每次**属性访问**都走 `internal/get` waterfall（trap 内 `Reflect.has(target, prop)` 的 own-property 特例与 accessor 定义是两个豁免通道——dsh 业务服务全部是 `Service`/provide 形态，`sessionPersistence` 即 `abstract class extends Service`，唯一 accessor 是 `ctx.agent`、唯一 mixin 是 vendor timer，均非业务路径）。**但 `ctx.get(name)` 方法调用不走 waterfall**：`reflect.get → _getImpl` 直接查 store（`reflect.ts:233-244` 实证）。消费面盘点：属性访问形态（`this.ctx.sessionPersistence.*`——message-feedback；inject 回调内 `childCtx.sessionPersistence`——agent-loop:445）**可拦截**；`ctx.get('sessionPersistence')` 直查形态（agent-loop:429,721 两处）**拦不到**——后者恰好属于「路由键在参数里」的服务面，由 §2.6 router 行覆盖，双轨合围后无死角。
  1. 只拦 `MULTISLOT` 白名单（枚举闭合），名单外一律 `next()`——杜绝误伤面；
  2. selector 自身取服务（realm 解析内部）不得再触发拦截回路（realm 内解析走 isolate 域内 reflect，不经根 waterfall——需在实现时验证，列入 §七待验证 1）；
  3. native 键 = 恒 `next()`，无任何额外开销与行为差（回归测试断言逐位一致）；
  4. `{ global: true }` 必须显式（ch05 反模式：scoped-out listener 静默失联）。

### 2.4 L3 —— wire 与持久化：三级键解析 + agentPreset 同构通道

**三级解析顺序**（在 gateway/`connection.fetch` 请求边界执行）：

```
1. request 显式键     —— 无 session 上下文的请求（createSession、modelCatalog、list 过滤）
                        携带 runtime 参数/头（wire 字段，见下）
2. session 归属键      —— 有 sessionId 的请求：session 的 runtime 归属（持久化，见下）
3. 'native'           —— 缺省回落（fail-safe 到原生，绝不 fail 到 foreign）
```

**持久化位（重大勘误 + 现成先例）**：M1 时期结论「header config 是 closed schema 无写入通道」仅适用于 request/header 的 `LlmCallConfig`（epoch header）。**`SessionHeader.agentPreset?: string`（`packages/core/session/src/types.ts:127`）+ SessionController create 路径（`packages/api/session-controller/src/agent.ts:375-382,482`：request 解析 `agentPreset` → 写入 session 组合 → 投影可读）构成「per-session 组合选择键经 controller 写入并持久化」的完整上游先例**。`runtime` 键完全同构落位：create 请求带 `runtime` → controller 写进 session 组合/投影 → 三级解析第 2 级读取。M0 registry 的 `ownsSession` 归属探询（内存）退化为冷启动缓存未命中时的补充手段。

**wire 面**：`POST /api/<ns>/<method>` body `{ args }` 已是自由 JSON（AGENTS.md wire 事实：`session/list` 固定 `_request`）；create/目录类请求在 args 增 `runtime` 字段，或 HTTP 头 `x-…-runtime`（kebab-case wire 惯例，ch09）。**不需要每个请求都显式带键**——凡有 sessionId 的请求，键已蕴含在归属里；显式键只服务「无 session 上下文」的少数面。

**归属解析的落地形态（2026-09-12 五问勘定，无全局态）**：后端**不存在**「当前 initiator」全局状态——ambient key 只活在单条请求链内。sessionId → realm 的解析由 **RouterPersistence 持有的归属索引**承担：boot 时对各 realm `list()`（各自存储，代价低）建 `sessionId → realm` 映射，create/删除时维护；`open/stat(sessionId)` = O(1) 索引命中，与请求来自哪个 tab/设备无关（同 sessionId 恒同 realm）。**两类失败语义分离**：sessionId 不在任何 realm → 上游 `session/not-found`（真实无效会话）；键解析失败（无归属请求未带键）→ fail-safe 回 native——**native 回退只适用于键解析，永不适用于会话查找**。

### 2.5 明确否决的替代方案（留档防复走）

| 方案 | 否决理由 |
|---|---|
| App 级单值 selector（multi-context §五形态） | 世界切换模型：一时刻一世界，无法两会话并发异 runtime；纯净投影裁决与 union 目录产品诉求直接冲突（两路线分歧点，见 §六） |
| monkey-patch 服务实例（V5 gateway 手法下沉到服务层） | 逐服务打补丁、无请求维度、实例重载即丢；`internal/get` 是同效果的原生机制 |
| 每个 runtime 一个 root Context（multi-context 本体） | 用户已排除；且聚合器要的是「一个数据面」，跨 Context 取服务把简单问题变成分布式的 |
| dsh-scope / createScope | 注册可见性分层，不隔离服务（scope-switch-route 实证）；且始于 agent 创建后，覆盖不了 BFF 前置请求 |
| loader 行热翻转（scope-switch-route） | 互斥形态：全 app 粒度、换出即杀在飞轮次——与共存哲学相反 |
| `fiber.update` / patch 行运行期翻转 | HMR/drain 红线（陷阱二），开发期机制误入运行期路径 |

### 2.6 双轨分派的另一半：provider-level router 行（「键在参数里」的服务）

`internal/get` 拦截的前提是**路由键在环境里**（ambient request key）。但有一类服务的路由键**在参数里**——`sessionPersistence.open(sessionId)` 的归属由该 session 决定、`list()` 要跨 realm 聚合：一次调用跨多个键，ambient 单值分派对它们语义就不对。这类服务用 **router 行**（llm `registerAdapter` Map 的同构形态 + M0 registry 装载先例）：

- **装载**：组合层 disable 原行 + insert 我们的 `RouterPersistence` 行（M0 registry 已实证的 disable+insert 形态）。
- **内部结构**：聚合持有各实现实例——native = 原样构造 jsonl 实现（上游实现类可直接实例化，`OmpUnionSessionPersistence extends SessionPersistence` 即先例）；omp/codex = 各自「DSH 自有存储」写入器（§四）。
- **路由规则**：`open/stat/export(sessionId)` 按 session 归属键（L3 第 2 级）选 realm；`list()` = 各 realm 聚合并打归属标；`create(header)` 按 header 的 runtime 键落对应 realm。
- **覆盖优势**：行替换发生在组合期，**一切访问形态**（属性访问、`ctx.get` 直查、inject 解析）最终都解析到 router 实例——§2.3 的 `ctx.get` 直查豁免被结构性补掉。
- **双轨分工**：键在环境（modelCatalog、presets 解析、modelSelection、agents 默认 factory）→ ambient + `internal/get`；键在参数（sessionPersistence、sessionQuery 聚合）→ router 行。两轨共用 L1/L3 的键来源与 realm 注册表。

---

## 三、多槽化改造有限集（六座大山 + 明确不动区）

### 3.1 需要多槽化的大山（完整清单）

| # | 服务（ctx 键） | 现状单例机理 | 多槽化方案 | 消费面 | 现成资产 |
|---|---|---|---|---|---|
| 1 | `agents`（AgentRegistry） | `setFactory` 单槽（动态，disposer 清槽） | **已完成**：M0 多槽 registry（disable 原行 + insert 新行装载），`#resolve` 三级路由在位；补 ambient 键直读 | session-controller、web | `apps/multi-agent/dsh-multi-agent-registry` |
| 2 | `sessionPersistence` | 根级唯一实现（jsonl）；OMP 时代靠覆盖根单例（union）造成污染 | **RouterPersistence 行（§2.6）**：disable 原 jsonl 行 + insert router 行，内部按 session 归属键路由 native/omp/codex 实现，`list` 跨 realm 聚合并打归属标；native 分支 = 原样持有 jsonl 实现实例 | agent-loop、message-feedback、schedule、session-checkpoint-policy、session-query 等（属性/get/inject 三种访问形态全被行替换覆盖） | SessionPersistence 接口契约（`create/open/stat/list/export`）；agent-omp `replay.ts`（OMP→DSH 事件转译，读路径已实证） |
| 3 | `llm` 目录/providers | **天然多槽**：`registerAdapter(providers, adapter)` + `adapters: Map`（源码实证 `packages/llm/llm/src/index.ts:331,384`），`llm/adapters-updated` 事件 | OMP/Codex 模型目录注册为**普通 provider/adapter**（tagged 共存，非 exclusive——agent-omp 曾有 `OMP_EXCLUSIVE_LLM_ROUTES` 探索，本路线改回共存并保留 tag） | agent-loop、settings、session-controller(modelCatalog) | 上游多槽机制本体；OMP `models.ts` 目录源 |
| 4 | `agentPresets`（roster） | 根级单 roster；omp-web 形态整体顶替（SingleOmpPresetRoster） | roster **命名空间合并**：`omp/*`、`codex/*` 前缀并入同一 roster 面；per-runtime 默认 preset 由归属键解析 | session-controller、agent 创建链 | agent-omp `agent-preset-omp.ts`（改顶替为注册） |
| 5 | `sessionQuery`（list/stat 面） | 单实现扫单存储 | 多 realm 聚合读：list = native store ∪ 各 foreign realm（每条带归属），stat/读按归属路由 | session-controller、web UI | M0 `ownsSession` 归属探询逻辑可迁移 |
| 6 | model-selection / 默认模型 | 进程级单默认 | 默认值按 runtime 键分片（`{native: …, omp: …}`） | agent-loop、settings | — |

### 3.2 明确不动区（防止改造蔓延）

- **`workspaceRegistry`（可选分片区，2026-09-12 问答裁决）**：工作区默认共享（物理事实，单实现最经济）；若产品上要 per-runtime workspace 视角（如 OMP 自有 workspace 投影、目录过滤差异），机制与 persistence 完全同构——进白名单/realm 清单即可，无任何机制特殊性。原「不动区」表述降级为默认经济选择而非机制约束。
- **`systemPrompt` / `tools` / `subagents`**：agent-loop 级组合，**随 runtime 的 loop 自带**——foreign loop（OMP/Codex）自带 prompt/tools 世界，不消费 DSH 侧这些服务；只要 foreign agent 的 inject 面不声明它们（agent-omp 现状即如此），就天然不串。
- **`settings` / `credentials`**：决策点（默认共享：OMP 走 DSH 凭据面更符合「统一入口」产品形态；若 OMP SDK 必须自持 API key 则 foreign 自持，标记为 §七待验证 4）。
- **webServer / connection / typertGateway / SessionController 本体**：wire 骨架全共享，selector 只在请求边界解析一次，controller 内部对多槽透明（它照常 `ctx.get`，L2 分派自然生效）。

**有限集判定：成立。** 真正要动的大山 = 上表 6 座，其中 1 座已完成、1 座是天然多槽只需注册、1 座是配置级分片；实质工程量集中在 #2（persistence realm + 写路径转译）与 #5（聚合读）。其余服务要么随 loop 走、要么共享，均无多槽需求。

---

## 四、Fully-Integration 数据面：OMP 融入的实质工程

### 4.1 双向转译层（本路线最大、也最有价值的新增资产）

```
用户消息（DSH UI）
  │ session/prompt（DSH SessionEvent: user/message 落 DSH log）
  ▼
OMP adapter（Agent 接口脸：send/steer/cancel/whenIdle + agent/status）
  │ deriveMessages()（DSH log）→ OMP prompt 上下文重建
  ▼
OMP runtime（bun sidecar 子进程，broker 托管——provider-seam §5.3 继承）
  │ turn 执行
  ▼
OMP 输出事件 ──转译──▶ DSH SessionEvent（assistant/message、tool/call、tool/result…）
  │                     │（append-only 落 DSH 自有 storage，即 realm #2 的写入器）
  ▼                     ▼
OMP 自有 store       DSH log = source of truth（UI/projection/resume 全走这边）
（byproduct，无消费者，duplicate 显式接受）
```

- **读路径资产已在**：agent-omp `replay.ts` / `omp-store.ts` 已实现 OMP 事件 → DSH 事件的转译词汇表（为桥接形态而生）——直接复用其映射表。
- **写路径是新增**：DSH 发起的会话，turn 全程事件必须落 DSH log（「model-visible means logged」不变量对 foreign session 同样成立——这是融入而非豁免）。OMP 侧写入其 store 的事实**不再回读**（单向阀：只写不读，杜绝双主同步问题）。
- **resume 语义**：DSH log `deriveMessages()` → 重灌 OMP 上下文（OMP 无「从外来 log 恢复」能力，resume = 以 DSH 历史为前缀新开 OMP turn——与 Claude Code `-p --resume` 类似形态，语义上 DSH 是主时间线）。

### 4.2 会话主键与隔离

- DSH sessionId 为唯一主键；OMP sessionId 藏进 `session/header` 后的 adapter 自有事件（`ignorable: true` 类信息事件），不进控制面。
- 「凡通过 DSH 发起的 OMP session」与「用户在 OMP TUI 里自建的 session」物理共存于 OMP home——前者 DSH 可全权管理，后者仅在未来「导入」功能里按需收编（Out of Scope，防双主）。
- **per-runtime 存储根（2026-09-12 三问补充）**：各 realm 自持存储目录，全部为 DSH SessionEvent 格式（同一 `SessionPersistence` 契约按 runtime 分根）——`$DSH_HOME/sessions/`（native 原地不动）+ `$DSH_HOME/agents/{omp,codex,claude…}/`。ambient key 在 create 时定归属；`open(sessionId)` 按归属路由到对应根。foreign 自家 store（OMP home 等）依旧只写不读。与 multi-context 线的 `dshHomePath` 按树覆盖问题对照：单 Context 下无需覆盖共享解析器，realm 各持存储根即可。

---

## 五、前端 UI：最大消费面 + 自愈（原则三）

### 5.1 消费矩阵与自愈承诺

| UI 面 | native | omp | codex | 缺段行为（自愈） |
|---|---|---|---|---|
| session list | ✅ | ✅（带归属徽标） | ✅ | 空 realm → 该段列表为空，组件原样渲染 |
| model picker | ✅ | ✅（provider 分组自动并入） | ✅ | adapter 未注册 → 不显示该组（原生 per-provider 行为） |
| 会话视图/流 | ✅ | ✅（转译后同词汇） | ✅ | 事件词汇未覆盖处按 `ignorable` 跳过（原生未知事件策略） |
| settings 卡片 | ✅ | 视 §3.2 决策 | 视同 | RemoteResult 非抛错误 → 卡片降级（原生行为） |
| workspace tree | ✅ 默认共享；可选 per-runtime 分片（§3.2 机制同构） | 同左 | 同左 | — |
| selector chip | `sidebar.footer.action`（M1 RuntimeSeat 直接复用；语义改为「新会话默认 runtime」+「list 过滤」） | | | slot 缺席 → 不渲染（可选占位契约） |

### 5.2 两个 UI 层红利（重大简化）

1. **model picker 天然分组、零 patch**：llm 目录以 provider 为组键（`registerAdapter(providers, adapter)`），原生 picker 本就按组渲染——OMP/Codex 注册为**独立 provider 名**后，目录里是各自的组，**不是「混一个大清单再打前缀」——「隔开」是天然形态**。若要更强隔离（selector=omp 时只显示 OMP 组），在 modelCatalog 响应层按 ambient 键过滤（modelCatalog 本就在多槽名单内，配置级改动）。
2. **dumb carrier 本体就是自愈机制**：client 调用 non-throwing `RemoteResult`、空数据段原生降级、未知事件 `ignorable` 跳过——上游 UI 的宽容度是设计出来的，不需要我们再加自愈层。

### 5.3 与 Multi-Context §五裁决的显式分歧（留档，防两线不变量互相误伤）

Multi-Context 路线的用户裁决「UI=单选中 runtime 纯净投影、禁 union listing、禁 per-item 标签」在**其产品形态**（世界切换）下成立且继续有效。本路线是聚合器形态，**union 目录 + per-item runtime 归属徽标是需求而非病灶**——但须守住边界：**per-item 归属只作呈现层元数据（list/filter），永不进入控制面路由决策**（路由仍由三级键解析独占，杜绝 provider-seam 时代「第二选择权威」复发）。两条路线各自的不变量表互不引用、互不豁免。

### 5.4 多消费者并发与 client 半同构（2026-09-12 四问补充）

**多消费者并发安全（结构性）**：归属请求的 key 从各自 session 归属解析（服务端持久，与 tab/设备无关——同 session 双端打开 = 同 key 同行为）；无归属请求的显式键是**每请求** hint（双 tab 各带各的，ambient ALS 每请求链独立值，服务端不存在可互踩的全局选中态）；$events 流在 open 帧绑 key，各链独立。**补规则（请求链外执行体）**：后台 job/schedule/在飞 turn 的子任务读不到 ambient——凡 servicing 某 session/job 的工作单元，在**创建时**把该 session 的 runtime key 铸进 job 元数据，执行时以 initiator 式 `withRuntime(key, op)` 包住（key 跟着工作单元走，不跟着「当前谁在看」走）。

**client 半同构（per-runtime UI 包 + 软重启）**：browser root 本就是 cordis fiber 树（client-runner/slots/client-modules），「fresh boot 而非 window.reload」= dispose 当前世界 UI 插件 fiber + 按新 key 挂载目标包。上游基石：`dynamicCordisRunner`（Host/Client 双半、版本化、激活门控）、boot graph/module table 随行集更新（scope-switch-route spike 3 已验证）、蓝图预留的 `@pgmi-builds/agent-ui-*` 呈现面包位。结构 = **两层 client 组合**：共享壳（sidebar/list/composer，native 不动）+ per-runtime UI 包（自有 slots/modules/theme，组合期就位可 disabled，切换零网络依赖）。key 切换 = 卸旧包 fiber + 挂新包；浏览器缓存改**按 key 命名空间化**，取代 M1 的 `localStorage.clear()+reload` hack。与 union 目录不冲突：union 是共享壳的数据面呈现，per-runtime 包只承载壳覆盖不了的部分。
**client 半软重启的真实执行者（2026-09-12 源码锚定）**：`@deepseek-ai/dsh-client-hmr` 的 client 半（`lib/client.js`）——`apply(ctx)` client 插件（inject loader），经 `EVENTS_ENDPOINT` 收 host 推送的插件事件帧，`reload(id, rev)`：`findEntry(loader, id)` → dispose 旧 fiber → `fiber.await()` → 挂载新模块。**浏览器 cordis root 的按行 fiber 卸载/重挂已在生产代码中存在**。key 切换的两条触发路：① host 半翻 per-runtime client 行的 disabled 位 → 既有 hmr 管道自动完成 client 侧重载（零新机制，首选）；② routing 包 client 半直接调同一 reload 例程。

---

## 六、路线关系图谱

| | M0 原路线（搁置） | **本路线（M0 分叉）** | Multi-Context（并行推进） |
|---|---|---|---|
| 产品形态 | 桥接宿主 | **单入口聚合 App** | Agent Orchestration Platform |
| Context 拓扑 | 单 Context | **单 Context + 全服务面分片** | 多 root Context + BFF 导流门 |
| selector 语义 | registry 投递键 | **session 级归属 + request 级 ambient + 目录 union** | App 级单值（世界切换） |
| foreign 数据面 | 自足（OMP store 真相） | **DSH store 真相，runtime=计算引擎** | 各自世界自有真相 |
| UI | 混流病灶 | union+filter 切面 | 纯净投影（不混不合） |
| 隔离强度 | 弱（根单例污染） | 中（名单化分片 + native 零变化） | 强（物理 Context 边界） |
| 复用关系 | — | 继承 M0 registry/投递路由/broker；继承 provider-seam 三原则 | 继承 ADR 0007/0008；与其共享 agent-omp 转译词汇表 |

两线共享 `agent-omp` 家族包的**转译层与子进程托管**，分歧只在数据面真相归属与 selector 语义——代码层面转译层可双向复用，selector 机制各自独立（本线 L1-L3 复合体 vs 该线 V5 gateway 实例委托）。

---

## 七、风险与动手前待验证项

1. **`internal/get` 拦截的再入与开销**（最高优先）：realm 内同名解析是否不经根 waterfall（避免递归）；拦截器在热路径（每次服务读）上的成本；`{global: true}` 监听器与 scoped listener 的次序保证。50 行 PoC 先行——对 fake ctx 验证「native 透传逐位一致 + foreign 分派正确 + 名单外零干预」。
2. **`runtime` 键进 wire schema**：SessionController create args 增字段是否被严格校验拒绝（`agentPreset` 先例存在，但 schema 严格度需实测）；被拒时的降级通道（HTTP 头）。
3. **（已验证，2026-09-12 二轮源码）`internal/get` 覆盖面精确边界**：属性访问（含 inject 声明的使用点，如 agent-loop:445 `childCtx.sessionPersistence`）**可拦截**；`ctx.get()` 直查（`reflect.get → _getImpl` 直接查 store，`reflect.ts:233-244`）**不走 waterfall**（agent-loop:429,721 两处）——由 §2.6 router 行结构性覆盖（行替换后一切解析路径都到 router 实例）。剩余 PoC 必答收窄为：①拦截器再入与热路径开销（与问 1 合并）；②inject 加载期绑定在行替换形态下不受影响的复核。
4. **settings/credentials 共享决策**：OMP SDK 凭据自持 vs 走 DSH credentials（产品裁决点）。
5. **写路径转译完备性**：OMP 事件词汇 → DSH SessionEvent 的映射缺口表（tool/call 参数形态、thinking/partials、错误轮次）；`ignorable` 策略对未映射事件的处理。
6. **并发回归矩阵**：双 tab 双 runtime 同屏（list 互不串、prompt 各归其主）、selector 中途切换在飞轮次归属（属旧绑定，provider-seam §5.3）、重启后 resume 归属恢复。
7. **上游零修改红线复核**：全部改动 = patch 行 + 自有包（registry 先例 disable+insert）；`internal/get` 监听是公开事件面（ch05 事件表在册），非私有 API——但需在对齐轮 diff 清单里盯 cordis `reflect.ts` 的 waterfall 签名漂移。

---

## 八、里程碑切片建议（每步独立可测交付）

- **M0'-A（机制骨架）**：L1 ambient + L2 拦截器（fake-ctx 单测）+ L3 三级解析探针 + RouterPersistence 装载冒烟；验收 = 待验证 1/3 收口 + native 回归逐位一致（含 `ctx.get` 直查形态）。
- **M0'-B（目录 union，最便宜最快见效）**：OMP 模型注册进 `ctx.llm`；验收 = 原生 model picker 出现 OMP 组，UI 零 patch。
- **M0'-C（persistence realm，最重）**：omp realm 写入器 + 转译层写路径 + sessionQuery 聚合读；验收 = DSH 发起 OMP 会话，刷新/重启/resume 全走 DSH log，native 会话无感。
- **M0'-D（presets/默认模型分片）**：roster 合并 + modelSelection 分片。
- **M0'-E（第二 runtime 泛化验证）**：Codex 走同一套机制接入——「机制成套与否」的试金石。

---

> **裁决与勘误存档**：
> - 2026-09-12 本文档推翻 provider-seam §5.4「外来 runtime 自足性」（该原则仍适用于 Multi-Context 路线，两线分治）。
> - 2026-09-12 勘误 M1 时期「header config closed schema 无写入通道」结论的适用范围：仅 request/header 的 `LlmCallConfig`；`SessionHeader.agentPreset` 同构通道（controller create 路径）可用作 runtime 键持久化位。
