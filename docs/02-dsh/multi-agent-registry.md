# Multi-AgentRegistry —— Registry 继承方案实施文档

> **【状态：搁置（SHELVED）2026-09-10】** 实测裁决定案：本路线只做到了 factory 多槽，
> 服务面（llm 目录 / sessionPersistence / presets / 默认模型）全部是进程级单例，外来
> loop 只能靠 disable 上游行腾位，两条线必然混流（详见 `apps/multi-agent/AGENTS.md`
> 与 2026-09-09/10 实测记录：模型目录恒 native、session 清单恒 OMP、运行时恒
> native）。方向暂停，另寻切入点；本文保留为推导与实证档案（含 routing v2 的
> in-memory 键 + ownsSession 契约）。备选路线材料：loader 行热翻转（作用域切入，
> `docs/02-dsh/scope-switch-route.md`）、多容器 Multi-Context
> （`docs/superpowers/plans/2026-09-10-multi-context-design.md`）。

- 日期：2026-09-09
- 性质：**实施级方向文档**（源码行级论证 + 代码骨架；registry 介入路线的落地形态）
- 源码锚点：`upstream/deepseek-harness` @ `dsh-v0.1.3-alpha.2`
- 上游推导：`docs/02-dsh/agent-runtime-provider-seam.md` §五（键值路由中枢定案——本文是它的实施展开）
- 姊妹方案：`docs/02-dsh/agent-runtime-provider-plugin.md`（坐槽者路由，A/B 中的 B 线）
- 实物参照：`~/workspaces/dsh-omp`（omp-web Adapter 全套，在产）

---

## 〇、结论速览

**不改一行上游源码、不复制任何代码：`export default class MultiAgentRegistry extends AgentRegistry`，override 三个方法（`setFactory` 兼容腿 / `appendFactory` / `create`+`resume` 路由），随发包 patch 一行把 base bundle 的 `id: agent` 行 `name` 重指到我们的包——多槽 registry 就位。**

（as-built：装载形态为禁原行+插新行，见 §二勘误——patch 行 name 是守卫专用。）占位机制不需要任何特殊语法：cordis `Service` 基类构造函数里的 `reflect.provide(name, this)` 会在子类实例化时自动完成服务注册（§一）。原生 `agent-loop` 经 `setFactory` 兼容腿无感知注册为 `native` 槽；外来 Agent Loop（OMP、PI agent）经 `appendFactory(key, …)` 各自注册，各自拥有独立 fiber/effect/disposer 时间线。

---

## 一、Magic word：类即插件即服务（源码论证）

`vendor/cordis/src/service.ts`，`Service` 基类构造函数：

```ts
constructor(protected ctx: Context, name: string) {
  ...
  self.ctx.reflect.provide(name, self, this[Service.check])   // ← 服务注册发生在这里
}
```

`packages/core/agent/src/index.ts:250`，`AgentRegistry`：

```ts
export class AgentRegistry extends Service {
  constructor(ctx: Context) {
    super(ctx, 'agents')     // ← 第一行
    ctx.inject(['typert'], …)     // typert lookups 注册
    ctx.accessor('agent', { get: () => undefined })
    ctx.on('internal/status', …)  // initiator 生命周期
    ctx.effect(…)                 // initiator drain 链
  }
}
```

完整占位链条：

```
patch 行 name → 我们的包 → loader 挂载 class plugin（export default Class）
→ cordis 实例化 → 构造函数链 super(ctx,'agents') → reflect.provide('agents', this)
→ 全进程 ctx.agents 解析到我们的实例
```

- **类即插件**：`AgentRegistry` 是 `export default`，cordis 的 class plugin 形态（loader 直接实例化，无需 `apply` 函数）。
- **类即服务**：`super(ctx, 'agents')` 在基类构造函数里完成 provide——**继承即占位**，不需要额外声明。
- **构造函数链原样跑**：typert lookups（`agent` lookup + context host）、`ctx.agent` DX accessor、initiator AsyncLocalStorage、`internal/status` 监听、drain effect——子类实例化时全部就位，上游 701 行零改动零复制。

### Object.create 的校准（设计推演记录）

提案原形：`NewAgentRegistry = Object.create(AgentRegistry)`。方向正确但对象需校准——

| | 空壳复用原型链 | 带状态的完整继承 |
|---|---|---|
| Context | ✅ `Object.create(ctx)`（ctx 无自有状态，设计如此） | — |
| Service 类 | ❌ 不跑构造函数：`store`/`initiators`/typert/effect 全在 constructor 初始化，空壳即崩；且继承的是类的静态侧 | ✅ `class X extends Y` |

cordis 官方确有 `Object.create(this)`——在 `Service[symbols.extend]`（"从已构造实例派生扩展实例"的官方用法）。结论：**`extends AgentRegistry` 就是 `Object.create(ctx)` 在 Service 类世界的同构物**：原型链复用全部方法 + 构造函数照跑 + provide 照发。

---

## 二、代码骨架

```ts
// packages/multi-agent-registry/src/index.ts（暂名 @pgmi-builds/dsh-multi-agent-registry）
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { getTraceable } from '@deepseek-ai/cordis'

export default class MultiAgentRegistry extends AgentRegistry {
  #factories = new Map<string, AgentFactory>()          // 多槽（原 #private factory 单槽弃用）

  /** 兼容腿：上游 agent-loop 构造函数硬编码调用，方法名不可改。 */
  setFactory(factory: AgentFactory): () => void {
    return this.#append('native', factory)
  }

  /** 多槽注册：外来 Agent Loop 的进入口。同 key fail-loud（保持 dsh 组合面纪律）。 */
  appendFactory(key: string, factory: AgentFactory): () => void {
    return this.#append(key, factory)
  }

  #append(key: string, factory: AgentFactory): () => void {
    if (this.#factories.has(key)) throw new Error(`an agent factory is already registered for "${key}"`)
    this.#factories.set(key, factory)
    // effect 语义照抄上游：注册 fiber 卸载时按 key 摘除
    return this.ctx.effect(() => {
      if (this.#factories.get(key) !== factory) return
      this.#factories.delete(key)   // （可选增强：连带 drain 该 key 的 AgentEntry，见 §五.3）
    }, `agents.append(${key})`)
  }

  /** 路由解析：投递时决策（delivery-time），永不触碰 fiber 生命周期。 */
  #resolve(sessionId: SessionId): AgentFactory {
    const key = routingKeyOf(sessionId) ?? 'native'     // 键值来源见 §四
    return this.#factories.get(key) ?? throwNoFactory(key)
  }

  async create(options: CreateAgentOptions): Promise<AgentHandle> {
    const { target } = { target: this.#resolve(options.sessionId) }
    const receiver = getTraceable(this.ctx, target)     // 上游委托形态原样照抄（index.ts:406-420）
    return Reflect.apply(target.createAgent, receiver, [this.ctx, options])
  }

  async resume(options: ResumeAgentOptions): Promise<AgentHandle> {
    const target = this.#resolve(options.resumeSessionId)
    const receiver = getTraceable(this.ctx, target)
    return Reflect.apply(target.resume, receiver, [this.ctx, options])
  }
}
```

```yaml
# cordis.patch.yml（随发包 dsh.bundle.patch 层；M0 as-built 修正 2026-09-09）
# cordis-plugin-include 0.1.3-alpha.2 把 patch 行的 name 作守卫专用、永不赋值
# ——"name 重指"在本版不存在，整插件替换 = 禁原行 + 插新行。
- id: agent
  name: '@deepseek-ai/dsh-agent'     # 守卫：上游行变了就 warn 跳过（防误 target）
  disabled: true
- insert:
    - id: agent-multi
      name: '@pgmi-builds/dsh-multi-agent-registry'
```

base bundle 现状：`packages/bundle/base/cordis.patch.yml:67-68`（`- id: agent` / `name: '@deepseek-ai/dsh-agent'`）。同 scope 重复 provide 的硬错不触发——原行被**禁用**、新行插入，`'agents'` 唯一提供者是我们。

> **勘误（2026-09-09，M0 实测）**：cordis-customization §3.3 与 plugin-development 决策树第 5 行的「patch 行 name 重指 = 整插件替换入口」对 0.1.3-alpha.2 **不成立**——`applyEntryPatches` 将 `name` 解构为守卫专用（vendor/include live 核实），永不赋值。可用的替换形态只有禁行+插行。§2.2 的守卫表述才是对的。

### 实施要点

1. **TS private 的规避是天然的**：上游 `store`/`factory` 是编译期 private；我们 override 的 `create/resume` 不读它们——多槽状态在自己的 `#factories`；`register/get/currentInitiator/withInitiator/…` 十几个方法经原型链原样工作（不依赖 factory 字段）。
2. **委托形态照抄**：`getTraceable(ownerCtx, target)` + `Reflect.apply(target.createAgent, receiver, …)`——receiver 追踪语义与上游一致，多态对 AgentLoop/OmpProvider/任何 AgentFactory 实现透明。
3. **同 key fail-loud**；disposer 按 key 摘除，fiber 卸载语义逐 factory 隔离。
4. **窄继承面纪律**：上游若改 `create/resume/setFactory` 签名或 constructor 加副作用 → typecheck 编译期暴露；对齐轮新增查表项见 §六。
5. **退路**：若上游封装化导致继承不可行，退化为源码级 fork（copy 701 行改名）——同一介入点，维护成本升一档。仅此情形才走 copy。

---

## 三、多 Agent Loop 并存形态（安装后即得）

安装（`dsh plugin add`，一次性）之后，进程内同时存在三个带 fiber 的 Agent Loop，生命周期方法全套对等：

| Agent Loop | fiber | 注册方式 | 厚度 |
|---|---|---|---|
| 原生 DSH agent-loop | 原有行，零改动 | `setFactory(this)` → `native` 槽 | 厚（完整 loop：LLM、tools、systemPrompt…） |
| OMP Agent Loop | 新 patch 行 | `appendFactory('omp', this)` | 薄壳（omp-web Adapter 搬移） |
| PI agent Loop | 新 patch 行 | `appendFactory('pi', this)` | 薄壳（同 PI 核心，与 OMP 共享底座） |

- 各自独立 fiber/effect/disposer 时间线；卸载语义按 key 隔离（`#append` 的 disposer）。
- **切换 = 路由不是切断**（seam §5.3 全部继承）：路由是投递时决策，UI 键值切走只是无观察者，切回数据流继续；在飞轮次属于它自己的 agent 跑完，无人打断。无 HMR、无 fiber 卸载、无 drain、无进程死亡。
- 外来 runtime 真正 on-demand 的是**子进程**（`omp --mode rpc` / claude CLI）：首次有会话路由到该 runtime 才 spawn，broker/managed-range 托管。adapter 壳本身随 host 常驻，很薄。

### ForeignAgent 的义务面（上游实证划定的边界）

- **不受原生 agent 事件流约束**：上游 `subagent-claude-code` 实证——外来 runtime 只受进程控制（`ctx.subprocess.spawn` + managed-range 分级终止），不实现原生 loop 内部逻辑，不消费 llm/tools/systemPrompt。
- **保持最小 session 合规脸**：omp-web 实证——Web UI 渲染链是原生 `session-controller → sessionQuery.observeSession`（读 session log 投影），外来 loop 必须呈现至少 header 的 session 面（转录事件量是适配自由度）。omp-web 的 `session-persistence-omp.ts`（provide `sessionPersistence`，JSONL ∪ OMP store 扫描）+ `supervisor.ts`（冷/影/持状态机、内容级外来写者检测、影子投影）为现成实现。
- **自持会话真相**：OMP/PI 有自己的 session 管理与 Session ID，外来持久化不依赖原生 session storage 主管权。
- 上游 `subagent-claude-code` 的 `process.ts`（`ManagedClaudeCodeProcess` 分级终止）与 `run.ts`（Agent SDK officialQuery 驱动 + SDKMessage 流解析）是 claude-code 线 future provider 的部件来源（该包内 `persistSession: false`、one-shot 契约决定了它自己是 subagent 定位，但进程托管与流解析可回收）。

---

## 四、路由键（两案共有的最后一块）

- **一条规则（M1 定案，2026-09-09 用户裁决）**：`runtime = header config.runtime ?? 'native'`。读时机 = 投递边界（delivery-time）：每次 create/resume 现读现判，**不做 lastUsed 类粘性缓存**（上游 modelSelection 的粘性行为是 controller 自己的职责面，registry 不继承也不模仿）。写路径 = 插件 RPC（§3.4）。
- **存储后端**：候选 = session header `config.runtime`（与 `provider/model/reasoningEffort` 同构）vs registry 自管旁路表（插件目录原子 JSON）。裁决待 M1 Task 2 调研（header schema 严格度 + 运行期写通道）；默认预期 = 旁路表（键不随 session log 迁移的代价已知并接受）。
- **降级语义**：键 miss 或对应 factory 未注册 = `native`（+warn）——卸载我们的包后一切回落原生行为，fail-safe 方向不变。

### 4.1 管道原则（spec 级约束，违反即设计缺陷）

registry 层的**唯一职责**是分流决策（读一个键、选一个 factory）。除此之外：

- `create/resume` 的 `options` 经 `Reflect.apply` **原样透传**（引用同一性）——不检查、不改写、不转发任何字段；
- provider/model/reasoningEffort 等参数是这条通路上的**交通流量**，归 controller 与 factory 两端管，registry 是管道不是关卡；
- 唯一允许的 registry 侧逻辑 = runtime 键的读写（读一条规则，写一条 RPC 路径）。

依据（2026-09-09 用户裁决）："如果我们在中间设关卡去检查具体逻辑，关卡会越来越堵，代码逻辑也会变得越来越臃肿。" M0 实现即已符合（透传 + 引用同一性），本节将其升格为不变量，并有守护测试防回归。

### 四-勘注（M1 Task 2 调研，2026-09-09）

上游源码证据（`upstream/deepseek-harness` @ dsh-v0.1.3-alpha.2，只读核验）：

- **A. header config 是封闭 schema，非 passthrough**。`EpochHeader.config` 类型为 `LlmCallConfig`（`packages/core/session/src/types.ts:230-231`），字段 = `provider/model/reasoningEffort?/temperature?/maxTokens?/stop?`，且注释明言「Every field maps 1:1 onto the same-named `GenerateOptions` field」（`packages/llm/llm/src/call-config.ts:23-35`）——config 是 LLM 调用配置，不是任意元数据袋。payload 校验为 closed record：required `['provider','model']`、optional `['reasoningEffort','temperature','maxTokens','stop']`（`packages/session/session-format-v0-to-v1/src/payload-validation.ts:799-806`），未知成员（如 `runtime`）直接 `SessionFormatError: unexpected member`（`validation-helpers.ts:28-33`；该校验在格式迁移读取时执行，`session-format-v1-to-v2/src/migration.ts:101`）。活路径 append 仅做 turn-enclosure 结构校验（`packages/core/session/src/invariant.ts:150-155`），但写入者唯一：agent-loop 本身（`packages/core/agent-loop/src/agent.ts:555-564`）。
- **B. create/resume 触发时点**。`session/prompt` **每条** prompt 都先 `resolveAgent`（`packages/api/session-controller/src/commands.ts:305`）→ live 命中直接用；无 live agent 则走 `agents.resume`（`agent.ts:428`）。`session/create` → `ensureSession` → `createOrAdopt`（`commands.ts:96`、`agent.ts:435`）：sessionId 已持久化时先 `observeSession` 命中 → **resume**（`agent.ts:460`），仅 `SESSION_QUERY_SESSION_NOT_FOUND` 才 `agents.create`（`agent.ts:477`）。
- **B'（既有 session、无 live agent）**：首条 prompt 走 **resume**（resolveAgent → agents.resume），不经 create。即常见切换流里路由键在 resume 边界被读；create-time 读只在全新会话首建时发生一次。
- **C. header config 无运行期写通道**。session RPC 面全集 = list/search/create/selectModel/modelCatalog/observe/openWorkspacePath/rename/fork/prompt/attachment/updateQueue/cancel/page + 2 stream（`packages/api/session-controller/src/index.ts:215-392`）。`rename` 写的是 `session/title` 事件（经 sessionTitle 服务，`commands.ts:168-175`）；`selectModel` 写 `model/selection`（`commands.ts:126-160`）——均非 header 重写。`request/header` 事件的唯一写者是 agent-loop 回合执行本身。
- **存储后端定案：(b) registry 自管旁路表（插件目录原子 JSON）**，依据：A 证明 header config 是封闭 LLM 调用配置 schema，塞 `runtime` 会触发 payload 校验拒绝/破坏迁移路径且语义错位；C 证明不存在可复用的 header 写通道，经 `sessionPersistence` 自写事件等于绕过校验伪造 loop 事件，改上游语义。旁路表零上游接触、迁移最简单（键不随 session log 迁移的代价已知并接受，见 §四上文）。

---

## 五、与坐槽者路由（B 线）的对照

| | 本方案（A：registry 继承） | B：坐槽者路由（CompositeLoop extends AgentLoop） |
|---|---|---|
| 改的模块 | 槽的定义者（`dsh-agent`，经继承占位） | 槽的第一个使用者（`dsh-agent-loop`，经继承） |
| registry 语义 | 变了：单槽 → Map（`setFactory` 兼容腿保持等价） | 完全原装 |
| 对上游其余部分 | 兼容腿维持等价，但语义面扩大 | 世界与原生不可区分 |
| 生态性 | **真平级**：外来 loop 独立注册/卸载，路由是框架级事实 | 第三方向我们的插件注册 |
| 继承面 | `create/resume/setFactory` 三点 + constructor 副作用 | `createAgent/resume` 两点 |
| 与 seam §五定案的对应 | **即定案本身**（§5.2 的 `registerFactory` = 本文 `appendFactory`） | 定案的插件化变体 |

两案共享：seam §5.3 全部行为保证、不碰 session-controller、路由键缺口（§四）、外来 Adapter 部件（omp-web 搬移）。**取舍一句话**：A 换生态性与显式性，付 registry 语义面；B 换最小扰动，付生态中心。用户裁决（2026-09-09）：先走 A。

---

## 六、待验证项（动手前）

1. **继承面运行验证**（M0 即验）：子类实例化后 typert lookups / accessor / initiator scope 正常；`agent-loop` 经兼容腿注册后原生会话全功能；`getTraceable` receiver 追踪在多 factory 间不串。
2. **`routingKeyOf` 的落点**：header `config.runtime` 的 schema 校验严格度；create 侧 RPC 携带方案与原生 session-controller 创建链的衔接（omp-web 先例核对）。
3. **AgentEntry 归属增强**（可选）：原 `register()` 的 disposer 绑在调用 fiber 上；若要"factory fiber 卸载只 drain 自己的 entries"（seam §5.2 第三条），需要在 `#append` 的 disposer 里连带 drain 该 key 的 entries——核对 `FactoryOwnership`（agent-loop 侧）与本侧职责边界，避免双重 drain。
4. **对齐轮查表项**：`AgentRegistry` constructor 副作用清单（typert/accessor/internal-status/effect）+ `create/resume/setFactory` 签名——上游变更时 typecheck 暴露后逐项评估。
5. **OMP Adapter 搬移面**：omp-web `OmpProvider implements AgentFactory`（`src/index.ts:111`）从"独占槽 setFactory"改为"appendFactory('omp')"的 diff 清单；`agent-preset-omp`/permission/models 的 provider 行随迁。

## 七、里程碑

1. **M0 registry 继承 PoC**：✅ 已完成（2026-09-09，报告 `docs/test-reports/2026-09-09-m0-multi-agent-registry.md`；装载形态 as-built 为禁行+插行，见 §二勘误）。
2. **M1 echo + 路由闭环**：`appendFactory('echo', …)` 回声 provider + 路由键（header/RPC）+ UI chip。验收：运行期切 echo/切回 native，无重启无重载无任务死亡（seam §六.6 实验的接口级扩大）。
3. **M2 OMP Agent Loop**：omp-web Adapter 搬进 `appendFactory('omp')` 形态。验收：OMP 会话在原生 DSH Web UI 全交互、与原生并存互切、宿主重启断档续播。
4. **M3 PI agent**：第二外来 loop（同 PI 核心），验证 ForeignAgent 底座泛化。

## 八、源码锚点索引

| 事实 | 位置 |
|---|---|
| `Service` 基类构造函数 `reflect.provide`（占位 magic） | `vendor/cordis/src/service.ts:54-70` |
| `Service[symbols.extend]` 的官方 `Object.create(this)` | 同上 `:83-92` |
| `AgentRegistry extends Service` + `super(ctx,'agents')` | `packages/core/agent/src/index.ts:250-256` |
| 单槽 `setFactory` / disposer / 双注册 throw | 同上 `:367-382` |
| `create/resume` 委托（getTraceable + Reflect.apply） | 同上 `:400-420` |
| `AgentFactory` 两方法契约 | 同上 `:176-210` |
| `agent-loop` 硬编码调用 `ctx.agents.setFactory(this)` | `packages/core/agent-loop/src/index.ts:420` |
| base bundle `id: agent` 行 | `packages/bundle/base/cordis.patch.yml:67-68` |
| patch 行 name 重指 = 官方整插件替换入口 | `vendor/loader/src/config/entry.ts:172-287`（cordis-customization §2.3） |
| 上游外来 runtime 只受进程控制的实证 | `packages/subagent/subagent-claude-code/src/{index,process,run}.ts` |
| omp-web Adapter/持久化/supervisor 现成实现 | `~/workspaces/dsh-omp/apps/omp-web/src/*.ts` |

### 四-勘注 2（routing v2，2026-09-09 user 裁决：废除旁路表）

上一勘注定案的 (b) registry 自管 JSON 旁路表被 user 否决：真正融入 Cordis 的系统不为「需要清单就实物化一个 JSON」——runtime 名单本来就是 registry 的内存 factory Map（Cordis 服务态，注册即得），per-session 键也不该有 registry 自有的第二份持久化。v2 定案：

- **内存键**：`routing.ts` 只保留进程内 Map（RPC 写入 / 探询问写回）。无文件、无路径派生、无 harness-home 接触。
- **重启后归属**：`ForeignAgentFactory.ownsSession(sessionId)` 契约——内存键缺失时 registry 逐个探询外来 factory，拥有者用**自己的** durable 索引主张归属（agent-omp-sdk 用 bridge-store `resolveEntryById`），命中写回内存（每会话每进程至多探一次）。探询抛错降级 native。无人主张 → native。
- **设计含义**：归属的 source of truth 回到各 runtime 自己的持久化（omp 的 union persistence 本来就承担 resume ownership），registry 不复制任何一份数据。先前「键不随 session log 迁移」的已知代价自然消失——归属随 runtime 自己的索引迁移。
- 上一勘注的 A/B/B'/C 源码证据仍然有效（它们证明的是「header 不是键的载体」，与 v2 结论一致）；仅「存储后端定案 (b)」一条作废。
