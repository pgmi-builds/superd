# DSH Agent Runtime Provider 介入面调研 —— 从寄生插件到键值路由中枢

- 日期：2026-09-08 ~ 2026-09-09
- 性质：研究文档（源码级调研 + 架构推导全程）
- 源码锚点：`upstream/deepseek-harness` @ `dsh-v0.1.3-alpha.2`；实物验证于 prod 3080 实例
- 关联：`docs/superd/00-blueprint.md`（Super D / OMP 桥接蓝本）、`05-dashr-dev/plugin-development.md`（cordis patch 机制）

## 〇、结论速览

把 DSH 的 agent factory 从**单槽**改造成**按键值匹配的路由器**（fork `@deepseek-ai/dsh-agent` 一个包，patch 行替换装载）：

1. 下游消费面（Web UI）：路由器呈现"当前 active 的 agent loop"，selector 切换 = 改一个键值（session header 的 `runtime` 字段），纯 presentation 层动作。
2. 上游逻辑面（session controller、session storage、LLM、配置）：对 factory 天生透明，多 agent loop 并发运行，互不卸载。
3. 切换不触发 cordis fiber 卸载、不需要 HMR、不 kill 在跑任务；键值切回来直接路由回内存中仍在运行的逻辑流。
4. 外来异构 runtime（OMP、Claude Code…）不依赖原生上游组件，自带独立逻辑，只经我们的 adapter 实现 `Agent` 接口脸。

---

## 一、起点：claude-in-dsh 的"寄生"形态（被否决为主路线，但部件可回收）

调研对象：https://github.com/GeekRicardo/claude-in-dsh （源码 clone 于 `.scratch/claude-in-dsh/`）。

机制：**不走任何 registry/provider 槽位**，而是寄生在事件缝上——

```js
ctx.on('agent/pre-step', async (payload, next) => {
  if (stateOf(sessionId).mode !== 'claude') return next()   // 普通会话放行
  await driveTurn(agent, payload.messages, payload.turn, payload.signal)
  return { kind: 'reject' }   // loop 以 'blocked' 关轮，从不发起 DeepSeek 请求
})
```

- `agent/pre-step` 是 loop 每次模型步前的 waterfall；插件对切到 Claude 的会话整轮接管，自己 spawn `claude -p --input-format stream-json …`，把 stdout 流翻译回 dsh 持久事件（`assistant/chunk`、`tool/call`、`tool/result`…）。
- 关键坑（其注释自述）：必须返回 `reject` 而非空 `enter`——waterfall 外层 wrapper（agent-instructions、skill-catalog…）会往 `next()` 返回值追加 context，空 enter 回流成非空 → Claude 跑完后 dsh 又跑一轮真的 DeepSeek。
- 权限/提问/计划审批/附件全部桥接到 dsh 现有服务（`ctx.get('approval')` / `'userQuestions'` / `'attachments'`）。
- 引擎切换是 composer chip（`conversation.input.left` 座位）+ 同源 RPC 改 `~/.cache/ccmode/state.json`，per-session、零重载。
- 会话终身互斥：跑过一轮即 `committed`（从 session log 的 `source.provider` 推断），重启不丢。
- **外置 broker**（`setsid` 脱离 + fifo `in` + append-only `out.log` + `meta.json`，落 `/tmp/ccmode/<sessionId>/`）：插件热更新、dsh 重启都杀不死在跑轮次，重连按字节偏移续读，重启期间输出"断档补播"。

否决理由：寄生形态——它没有坐进任何正式槽位，靠事件拦截旁路了整个 runtime 抽象。
**可回收部件**：① Claude 流 → dsh 事件词汇的翻译层；② broker 进程托管模式；③ per-session 引擎状态持久化模式。

## 二、单槽核实与"官方"热插拔机制

### 2.1 单槽的真相

`packages/core/agent/src/index.ts` — `AgentRegistry`（cordis service `'agents'`）：

```ts
setFactory(factory: AgentFactory): () => void {
  if (this.factory !== undefined) throw new Error('an agent factory is already registered')
  this.factory = { target: factory }
  return () => { this.factory = undefined }   // disposer：插件卸载即清槽
}
```

- 单占确认：双注册 throw。
- 但它是 cordis effect 语义：`agent-loop` 构造函数里 `ctx.effect(() => ctx.agents.setFactory(this))`，fiber 卸载自动清槽——槽是**动态单槽**，不是死槽。
- `agent-loop` 自称 "Concrete agent-loop plugin"——不是特权核心，只是第一个坐进槽的插件。
- `AgentLoop.inject = ['agents','sessions','llm','tools','systemPrompt','sessionProjections']`——`llm` 是 agent-loop 自己要用的，**factory 不强制依赖 llm**，异构 runtime 可以完全不碰。

### 2.2 热插拔三机制（全部源码确认）

1. **patch 行 live 重载**：web profile `patchReload: 'live'`（`PROFILE_TEMPLATES`，prod manifest 未写 → 模板默认 live）。boot 对 `profiles/web/cordis.patch.yml` 与 `~/.dsh/cordis.patch.yml` 装 watcher，编辑即原地重载受影响 fiber；无模块 HMR 时自动挂 config-only `cordis-plugin-hmr`（`root: []`）专管（`apps/cli/src/profile-boot.ts:283` 起）。
2. **模块级 HMR**：`cordis-plugin-hmr`（base bundle 有行、默认 disabled），文件 watch → loader 重载模块。
3. **fiber 卸载语义**：effect disposer 清槽；FactoryOwnership teardown drain 活 agent（abort 在飞轮次）；session log（jsonl）不删，`agents.resume` 经新 factory 重新发布。

结论：换槽 = patch 行翻转，保存文件即生效，服务器/WS 不动。**但** drain 会 abort 在飞轮次——这是后续设计要绕开的点。

### 2.3 换槽代价边界

- 断：该 factory 造的全部活 agent（在飞轮次取消）。
- 不断：服务器进程、WS（可续连）、session 持久日志、UI（读 session 投影）。
- resume 链：web `session-controller.resolveObservedAgent → agents.resume/create`（`api/session-controller/src/agent.ts:428/460/477`）——只认 registry，不认具体 factory。

### 2.4 两层接入面分流

| 层 | 槽位形态 | 适合谁 |
|---|---|---|
| `llm` adapter 注册表 | **多槽**，按 provider id，waterfall 可拦截 | 纯模型 API |
| `agents.setFactory` | 单槽（动态） | 自带工具循环的完整 runtime |

## 三、物理形态探测（prod 3080 实证）

问题：DSH 原生 loop 是同进程、协程还是子进程？换出时谁 keep alive？

**实测（2026-09-08，PID 3229452 = `dsh web`，RSS 377MB，13 线程 = 标准 Node 线程池）**，全部子进程：

| 子进程 | 身份 |
|---|---|
| `npm exec @z_ai/mcp-server` | MCP stdio 插件 |
| 2 × `python -m ipykernel_launcher` | dashr `eval` 工具 kernel（每会话一个） |
| 1 × `bwrap … next dev` | 某 agent 会话的 bash 工具调用（沙箱内） |

**没有任何代表 agent 会话的进程。** 多会话 = 同进程内存对象（`AgentEntry`）+ 事件循环上的 Promise 链。cordis fiber 是逻辑生命周期作用域，不是 OS 线程/协程。keep-alive = 事件循环攥着未决 Promise。模型调用是同进程 HTTPS；`jobs-local` 同进程。

推论：

1. "原生 loop 被换出时 keep alive"物理无解——没有进程可接管/伪装，async 链 unload 中止是协作式的（AbortSignal 掐请求）。**但这不是我们的缺口**：per-session 切换不触碰原生 fiber；全局换 provider 是一次性安装动作，safe-restart 语义可接受。
2. keep-alive 只对外来 runtime 存在，而它们有真实进程：adapter 自己 spawn + broker 脱离持有（对照：dsh 自己的工具子进程全 `--die-with-parent` 跟宿主共存亡，broker 故意不挂）。宿主重启杀 ipykernel/bwrap 也是实证（dashr kernel 需 spin-up 重建的物理原因）。
3. 原生在飞轮次迁移到别处继续：谁都做不到（包括上游），不列为缺口。

## 四、方案演进全程（含被否决/被深化的中间形态）

### 阶段一（被深化，未否决其价值）：composite factory —— 零 patch 纯增量插件

坐进现有单槽，内部 per-session 路由：原生会话托管 ReactLoopAgent 为子 factory，外来会话路由到 adapter。
- 优点：零 fork、纯插件、立即能验证多 runtime 共存 + drop 不杀进程。
- 局限：多槽语义藏在插件内部，第三方 runtime 无法独立注册（无生态性）；仍占着单槽，"换出 composite"本身仍是一次 drain。
- **定位：概念验证与过渡形态；对 OMP 单一桥接场景概念上全覆盖。被阶段三的路由器形态取代为主方案，但仍是零 fork 快速验证的路径。**

### 阶段二（被深化）：fork 多槽 registry

patch 行 `id: agent` 覆盖 + name 重指，fork `@deepseek-ai/dsh-agent`：`setFactory` → `registerFactory(key, factory)`，`AgentEntry` 记 factory 归属，unload 只 drain 自己的。
- 为什么必须 patch 行而非插件再 provide `'agents'`：cordis 同 scope 同名 service = 硬错（plugin-development.md 硬边界②）。
- 优点：第三方 runtime 插件各自独立注册/卸载（生态性）。
- 局限：仍以"槽位集合"为心智模型；切换语义仍绑注册/卸载。
- **定位：阶段三的前半部分——它的 registry fork 改动被路由器方案完整吸收。**

### 阶段三（当前定案）：键值路由中枢 —— LLM provider 同构形态

用户洞察：LLM 天然多槽且切换完全不触动 agent loop 重载，对 LLM 消费者只是 "current selected"。agent loop 应改造成同样形状——**修改 provider 只是 presentation 面，不是运行时热重载**。

修正后的切入点：不把逻辑架构在插件槽位层面（会触发 cordis HMR/fiber 卸载、天然杀任务），而是把 agent factory 层改造成**按键值匹配的路由器**（详见第五节）。

## 五、定案架构：上游/下游分面的键值路由器

### 5.1 分面原则

1. **下游消费面**：路由器只对 Web UI 呈现当前 active 的 agent loop。selector 从 DSH 切到 OMP = 后端把前端消费面的键值切换成 OMP，路由到我们的 adapter。
2. **上游逻辑面**：session controller 等底层组件对 factory 透明，天生多路由、多 agent loop 并发运行。原生 loop 永不卸载、永不被换出——路由表不再指向某外来 factory ≠ 卸载它。

### 5.2 核心改动（fork `@deepseek-ai/dsh-agent`，patch 行 `id: agent` 整行替换，一次性安装）

- `setFactory` → `registerFactory(key, factory)`（Map）+ create/resume 委托处的**路由解析**：`options.runtime ?? session.header.config.runtime ?? 'native'`。
- 兼容腿：保留 `setFactory(factory)` ≡ `registerFactory('native', factory)`——**上游 `agent-loop` 零改动**，无感知注册成 native 槽。
- `AgentEntry` + `factoryKey`；某 factory fiber 真卸载时只 drain 自己的 entries。
- 路由键持久化：session header `config` 新增 `runtime` 字段，与既有 `provider/model/reasoningEffort` 同构（resume 读它选 factory）。`provider`（LLM 路由）与 `runtime`（loop 路由）正交，文档写死。

### 5.3 multi-fiber 语义：fiber 生命周期与观察者正交（用户裁决，2026-09-09）

**核心原则：路由器不触碰任何 fiber 的生命周期。** fiber 有没有消费者与其存活无关——不能因为当前没有观察者就停掉整个 fiber。agent 任务可能跑很久，不去动它，它的生命周期就一直在。

> 比喻：房间里睡着一个人。你开灯，看见人在这；你关灯，这个人依然在。前端键值切走 = 关灯；切回 = 开灯，数据流继续有人消费而已。

cordis 侧的事实支撑（`01-cordis-runtime/cordis-customization-and-override-mechanics.md`）：

- **fiber 本身是不动的，它就是一个运行时状态**。fiber 树的形状 = patch 行组合的结果。我们的设计里**连 `fiber.update` 都不需要，并且要尽量避免调用**——`fiber.update(config, true)` 的语义（增量更新还是触发一次插件级热重载、内存中在跑的 session 会不会被波及）目前了解不透彻，在勘明之前一律按"碰都别碰"处理。只要不热重载、不 update、行还在，原生 DSH 的 agent-loop fiber 就永远在线，数据流照跑。
- **registry 本来就是多 agent 并发的**：一个进程内多个 live `AgentEntry` 各自挂着自己的 async 链，UI 观察与否、观察谁，都与它们的存活无关（dispose 只由显式关闭或所属 factory fiber 卸载触发——而我们的设计里后者永不发生）。

由此推出路由器的准确行为：

- **路由是投递时决策**（delivery-time），不是生命周期决策：每条进来的用户消息/每次 create，按当时键值绑定投给对应 agent。在飞轮次属于它自己的 agent，继续跑完，无人打断。
- **adapter fiber 随 host 启动，不是 on-demand**（用户修正，2026-09-09，收回早先"热启动"表述）：凡加载进 Cordis 的插件，不涉及槽位就不会热重载；我们的 Adapter 是登记在 patch 里的普通插件、很薄的一层，没有上游外来 Agent Loop 时基本不占内存，直接随 host/核心启动常驻。**真正 on-demand 热启动的是被我们发起的上游外来 Agent Loop 子进程**（经 CLI / RPC / HTTP API 持有）——首次有会话路由到该 runtime 时才 spawn，由 broker 托管。
- **切走 ≠ 停止**：键值切回原生 DSH 时，外来 fiber 没有断，只是暂时无观察者；再切回来，导流继续。反向同理。multi-fiber 并存是常态而非切换的过渡态。
- **历史设计（保留存档，后被 2026-09-09 讨论反驳调整）**：曾提出"活 agent 换 runtime：idle 时 dispose entry → 经新 factory `resume`（session log 完整）"。当时的思路是把换 runtime 当成一次受控的重挂，仍然是单槽心智的残留——它隐含"换出"动作的存在。反驳理由：路由器架构里不存在换出，fiber 与观察者正交，dispose/resume 循环整个不必要；"内存不回收"的正确表述是**没有任何实体被回收**——不卸载 fiber、不 drain agent、不杀进程。保留此记录以免后续探索重走"切换=重挂"的弯路。

与 LLM provider 的对照只剩一个残余差异且已被上述原则吸收：LLM 按调用选槽是毫秒级无状态；agent 侧的"选槽"落在**消息投递边界**上，而 agent 自身（毫秒级还是分钟级）完全不受投递路由影响——它只管跑完自己的事。
### 5.4 外来 runtime 的自足性

外来异构 runtime **不消费、不依赖**原生上游的 session controller、session storage、LLM、配置项——自带独立逻辑（OMP 有自己的 session 管理与 Session ID）。我们的 adapter 只需：

- 实现 `Agent` 接口脸（`send/steer/inject/followup/cancel/whenIdle/runMaintenance` + `agent/status` 事件）供 UI 驱动；
- 最小合规写 session 事件（至少 header；转录事件量是适配自由度——无消费端时可以最小化）；
- 进程托管走 broker（setsid + fifo/append-log + 偏移续读），factory 换血/宿主重启都不杀外来进程。

### 5.5 效果清单

- 切换 = 一次数据写入（header 键值）+ presentation 更新。无 HMR、无 fiber 卸载、无 drain、无进程死亡。
- 键值切回 → 直接路由回内存中仍在运行的逻辑流（native 在飞任务从未被打断）。
- 介入面收敛为：① 一个 fork 包（dsh-agent）+ 一行 patch 替换；② 每个外来 runtime 一个增量 patch 行 + adapter 包；③ UI 一个 selector chip。

## 六、待验证项（动手前）

1. **header config schema 校验**：`request/header` 事件若对 config 严格校验（session 包），`runtime` 字段需同步 schema——确认 strict 还是 passthrough。
2. **`AgentOptions` 扩展面**：`CreateAgentOptions`/`ResumeAgentOptions` 透传 `runtime` 的路径（web 端 selector → controller → registry）。
3. **路由器与 initiator scope / typert 注册的兼容**：fork 不破坏 `AgentRegistry` 构造函数里的 typert lookups 与 initiator invariants。
4. **投递边界的并发安全**：同一 session 键值切换瞬间在飞消息的归属判定（属旧绑定还是新绑定），以及外来 adapter agent 与原生 agent 同 session 并存时的 session log 写入协调（若外来 runtime 选择最小写入则此点自动消解）。
5. **`fiber.update` 语义勘明**（防御性）：确认 `fiber.update(config, true)` 是增量应用还是触发插件级热重载、内存中在跑的 session/agent 会被波及到什么程度。设计上我们避免调用它，但需知其边界，防止上游或其它插件的行为间接牵动（例如 patch 行 config 变更会不会走 update 路径）。
6. **demo factory 实验**（零 patch 前置验证）：~100 行 echo factory 插件，验证 patch 热翻转、原生渲染、切回 resume 三点闭环（该实验同时是阶段一的遗产）。

## 七、源码锚点索引

| 事实 | 位置 |
|---|---|
| 单槽 setFactory / disposer | `packages/core/agent/src/index.ts:367-382` |
| AgentFactory / AgentHandle 契约 | 同上 `:176-210` |
| Agent 运行期脸（send/steer/cancel…） | `packages/core/agent/src/runtime-types.ts:120-200` |
| agent-loop 注册 factory | `packages/core/agent-loop/src/index.ts:420` |
| pre-step waterfall / reject 语义 | `packages/core/agent-loop/src/agent.ts:241-249` |
| web create/resume 调用面 | `packages/api/session-controller/src/agent.ts:428/460/477` |
| patch live watcher + config-only HMR 兜底 | `apps/cli/src/profile-boot.ts:283-320` |
| PROFILE_TEMPLATES web=live | `packages/boot/app-boot/src/profile.ts:106-125` |
| base bundle patch 行（agent / agent-loop / hmr-disabled） | `packages/bundle/base/cordis.patch.yml:21,67,472` |
| 进程树实测 | 2026-09-08，PID 3229452（见第三节） |

---

> **勘误（2026-09-09，M0 实测）**：本文 §5.2「patch 行 `id: agent` 整行替换」的装载表述在 0.1.3-alpha.2 需修正为**禁原行 + 插新行**（`applyEntryPatches` 把 patch 行 `name` 作守卫专用，永不赋值——live binary 核实）。架构结论不变：`'agents'` 唯一提供者换成我们的包。其余推导不受影响。
