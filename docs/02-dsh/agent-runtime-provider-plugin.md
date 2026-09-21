# DSH 插件形态的 Agent Runtime Provider —— 方向文档

- 日期：2026-09-09（v3，骨架重排：运行时切换 feature 为第一公民，Cordis 插件机制降为安装附录）
- 性质：**开发方向文档**（方向性 + 源码级介入点核实；比研究文档进一步，仍非执行计划）
- 源码锚点：`upstream/deepseek-harness` @ `dsh-v0.1.3-alpha.2`；实物参照 `~/workspaces/dsh-omp`（omp-web，在产）
- 前置研究：`docs/02-dsh/agent-runtime-provider-seam.md`（推导全程与 §5.3 裁决原则，本文不重复、只消费）
- 机制依据：`docs/05-dashr-dev/plugin-development.md`、`docs/01-cordis-runtime/cordis-customization-and-override-mechanics.md`

---

## 〇、定位

**交付物是一个 app feature：用户在运行中的 DSH Web UI 里，把当前会话的 agent loop 切换成外来 runtime（OMP、Claude Code…），或切回原生——切换是数据写入，不重启、不重载、不死任何在跑任务。**

这个 feature 以 DSH 插件的形态分发（`dsh plugin add` 一次安装），但插件形态只是分发外壳。feature 本身的实现里，用户路径上不出现任何 Cordis 概念。

| 线 | 形态 | 状态 | 关系 |
|---|---|---|---|
| Super D（`docs/00-blueprint.md`） | 独立 App（最小 cordis 宿主 + 桥接层） | 蓝图 v0.4a + P1 计划就绪 | 并行方向；Super D 面向"自带宿主的多机拓扑"，本方向面向"寄生在用户已有 dsh 安装上" |
| fork 路由器（seam 文档 §五） | fork `dsh-agent` 键值路由中枢 | 研究定案，未实施 | 本方向的**升级路径**（§六触发器）；两者共享 §一的全部行为保证 |
| **本方向（本文）** | **纯 DSH 插件，零 fork、零源码修改** | 方向文档（本文） | 路由逻辑与 fork 方向同构，宿主从"dsh-agent fork"换成"一个继承 AgentLoop 的插件" |

---

## 一、第一公民：运行时切换 feature

### 1.1 用户路径（唯一要交付的东西）

```
用户在 Web UI 会话里 → 点 composer 左侧的 runtime chip → 选 OMP / Claude Code / DSH
→ 下一条消息投给选中的 loop
```

与 LLM provider selector 的使用体验完全同构——seam 文档 §四阶段三的原始洞察：**LLM 天然多槽且切换完全不触动 agent loop 重载，对消费者只是 "current selected"；agent loop 要做成同样的形状。**

### 1.2 行为保证（验收红线，全部继承 seam §5.3）

1. **切换 = 一次数据写入**（路由键值）+ presentation 更新。无 HMR、无 fiber 卸载、无 drain、无进程死亡。
2. **路由是投递时决策**（delivery-time），不是生命周期决策：每条进来的消息按当时键值绑定投给对应 agent；在飞轮次属于它自己的 agent，继续跑完，无人打断。
3. **切走 ≠ 停止**：键值切回原生时，外来侧没有任何实体被回收（不卸载 fiber、不 drain agent、不杀进程），只是暂时无观察者；再切回，数据流继续被消费（开灯/关灯比喻）。反向同理。multi-runtime 并存是常态，不是切换的过渡态。
4. **原生 loop 永不卸载、永不被换出**——路由表不再指向某外来 runtime ≠ 卸载它。路由器不触碰任何 fiber 的生命周期。

**检验句：在"用户切换 runtime"这个动作的描述里，不允许出现 patch、yml、热重载、插件装卸、重启中的任何一个词——出现了就是设计错了。**

---

## 二、原则：Cordis 插件系统是开发期系统

（本节是对 v1/v2 版错误的正式纠正记录）

- patch 行、live watcher、HMR、fiber 装卸——这整套 Cordis 机制服务的是**开发者迭代与运维部署**：改代码热更新、装/卸插件、组 profile。它是"怎么把代码装进进程"的答案。
- 运行期改 yml 等热重载，是开发者的调试便利，不是使用者功能。**任何把 patch/HMR 暴露到用户切换路径上的方案一律否决**——没有人为了换个引擎去后台改配置文件然后等 App 重载。
- 推论：运行时切换 feature 的实现代码里，**插件机制只出现在一个地方——安装那一刻**（§四）。安装之后，feature 的全部运行面是：路由表（数据）+ RPC（接口）+ UI chip（presentation）+ 投递时路由（行为）。
- 对应 seam 文档 §四阶段三的修正原文："不把逻辑架构在插件槽位层面（会触发 cordis HMR/fiber 卸载、天然杀任务），而是把 agent factory 层改造成按键值匹配的路由器"。

**单槽的准确表述**（替换 v2 的"单槽不是障碍，独占才是"）：单槽约束的是"同一时刻进程里只有一个 factory 身份"，即**谁有权造 agent**；它不约束"造哪种 agent"——因为路由发生在 factory 内部。omp-web 是独占式接入：把 factory 身份整个换成外来者，于是原生不存在、没有切换。本方向是路由器式接入：factory 身份交给一个会路由的 composite，native 和所有外来 runtime 都是这个槽内的路由目标。**差别不在槽，在坐槽者会不会路由。**

---

## 三、实现：坐槽的路由器

### 3.1 CompositeLoop（host 半核心）

`packages/core/agent-loop/src/index.ts:359,916`：`AgentLoop` 是 public class + default export，`implements AgentFactory`，`createAgent/resume` 是公开方法，构造函数末尾 `ctx.effect(() => ctx.agents.setFactory(this))`——注册进单槽的 `this` 就是实例本身。

```ts
import AgentLoop from '@deepseek-ai/dsh-agent-loop'

export default class CompositeLoop extends AgentLoop {
  async createAgent(ownerCtx, options) {
    const runtime = this.#routing.lookup(options.sessionId)          // miss = 'native'
    if (runtime === 'native') return super.createAgent(ownerCtx, options)
    return this.#providers.get(runtime).createAgent(ownerCtx, options)
  }
  async resume(ownerCtx, options) {
    const runtime = this.#routing.lookup(options.resumeSessionId)
    if (runtime === 'native') return super.resume(ownerCtx, options)
    return this.#providers.get(runtime).resume(ownerCtx, options)    // provider 自管外来 session 格式
  }
}
```

- **原生路径 = `super.` 继承**：rollback 事务、session mint、`agent/session-start`、loop 启动、FactoryOwnership、configured agents、systemPrompt variables 全部一行不漏继承。没有第二次 `setFactory`、没有双占 throw、没有隔离 realm 把戏。
- **窄继承面纪律**：`AgentLoop` 的 private 字段（`ownership`/`runtime`/`config`）子类不可触也不需触——路由决策只发生在 `createAgent/resume` 的参数与返回值层面。registry 的委托方式 `Reflect.apply(target.createAgent, receiver, …)` 对子类透明（`packages/core/agent/src/index.ts:400-420`）。
- registry 本来就是多 agent 并发的：多个 live `AgentEntry` 各挂各的 async 链，UI 观察与否与存活无关——native 与外来 agent 在同一个 registry 里并存，这是上游既有语义，不是我们发明的。

### 3.2 路由键

`AgentOptions` 是闭合形状（`provider/model/reasoningEffort/maxTokens`），controller 的 `agentOptions()` 只填 provider/model——上游没有 per-session runtime 字段的透传链（seam §六.2 在 fork 方向的解法是把 `runtime` 写进 session header config；插件方向不 fork 改不了那条链）。本方向的键值旁路：

- **存储**：插件自有持久化表 `{"<sessionId>": "<runtimeKey>"}`，原子写，插件自有数据目录。
- **写面**：RPC（§3.4），由 UI chip 调用——这是 feature 的唯一运行期写面。
- **降级语义**：查表 miss = `native`——插件卸载/表丢失，一切会话回落原生行为，fail-safe 方向正确。
- **已知代价（接受并记录）**：绑定不随 session log 迁移（导出/导入不带走）；跨机同步是 Super D 线的事。fork 方向可消此差距——记入 §六升级触发器。

### 3.3 RuntimeProvider 子注册表

```ts
interface RuntimeProvider {
  key: string                       // 'omp' | 'claude-code' | …
  describe(): { label, icon?, available: boolean }
  createAgent(ownerCtx, options): Promise<AgentHandle>
  resume(ownerCtx, options): Promise<AgentHandle>
}
```

- 我们的插件 `ctx.provide('agentRuntimeProviders', …)` 多槽服务；第三方外来 runtime 插件 `inject` 后按 key 注册，key 冲突 fail-loud。**生态性在本层恢复**（对照 fork 方向的 `registerFactory(key, …)`，语义等价）。
- **`ExternalAgentBase`**：外来 runtime 的 Agent 脸底座——实现 `options/session/inbox/status/ctx` + `send/steer/inject/followup/cancel/whenIdle/runMaintenance` + `agent/status` 事件；mint 最小合规 session；把 UserMessage 翻译为对外来子进程的输入。
- **部件来源 = omp-web 在产代码的泛化搬移**：`agent.ts`（1071 行 Agent 脸 + 事件翻译）、`supervisor.ts`（冷/影/持/避状态机、内容级外来写者检测）、`rpc.ts`、`replay.ts`、`session-persistence-omp.ts`、`models.ts`。claude-in-dsh 的翻译层覆盖第二来源（seam §一可回收部件①）。
- **进程托管**：adapter 常驻（很薄，无外来 loop 时基本不占内存）；真正 on-demand 的是外来 runtime 子进程——首次有会话路由到该 runtime 才 spawn，broker 托管（setsid 脱离 + fifo/append-log + 偏移续读，宿主重启杀不死，重连断档补播；seam §5.3/§5.4 原样继承）。omp-web 的 `supervisor.ts` 已解决冷启动/影子投影/双写冲突三类现实问题。

### 3.4 RPC 与 UI chip

- RPC：`ctx.webServer.register`（prefix 路由），面 = list/get/set runtime（session 维度）。feature 的运行期接口。
- UI：client 半 `ctx.slots.register` 进 `conversation.input.left`（list、session-maybe scope、独立 id、默认 priority，不遮蔽任何原生 cell）。读当前会话路由键 → 展示 active runtime → 点击经 RPC 改键。纯 presentation。构建循走 client 半正规链（`dsh.client` 声明 + `exports['./client']` + boot graph 验证，plugin-development §3）。

---

## 四、安装（一次性动作，附录性质）

安装是这个 feature 唯一触碰 Cordis 插件机制的地方——与 omp-web 的 `dsh plugin add` 同语义，safe-restart，用户装完之后再也见不到本节内容。

1. 包随发 `dsh.bundle.patch`（`cordis.patch.yml`），`dsh plugin add` 进入 profile bundles。
2. patch 两行（as-built 修正 2026-09-09：0.1.3-alpha.2 的 patch 行 `name` 是守卫专用、不可赋值，「name 重指」不存在）：`{id: agent-loop, name: 原值守卫, disabled: true}` + `insert {id: agent-loop-composite, name: 我们的包}`。此后每次启动，坐进单槽的就是 CompositeLoop，安装即永驻。
3. 部署形态照抄 omp-web：8 个 `@deepseek-ai/*` optional peers 由 host 自供，profile 树零嵌套副本（`.npmrc` `auto-install-peers=false`）。
4. 互斥：同一 profile 不能同时装本插件与 omp-web（都在单槽上）。迁移路径：omp-web 独占 profile → 本插件多 runtime profile。
5. 升级/卸载 = 又一次安装期动作（safe-restart）。drain 只发生在这里，等价于任何一次宿主重启。

---

## 五、与 fork 路由器方向的对照（何时升级）

| 维度 | 本方向（插件继承） | fork 路由器（seam §五） |
|---|---|---|
| 上游侵入 | 零 | fork `dsh-agent` 整包 |
| 路由键 | 插件旁路表（不随 session log） | session header `config.runtime`（同构持久） |
| 第三方 runtime 注册 | 向我们的插件注册（生态中心 = 我们） | 直接向 registry 注册（生态中心 = 上游形状） |
| 对齐负担 | 盯 `AgentLoop` 公开继承面（极窄，typecheck 编译期暴露） | 盯 fork 包全部 diff |
| 原生保留 | super 继承，天然并存 | 兼容腿 `setFactory ≡ registerFactory('native')` |

两者共享 §一的全部行为保证——差别只在"路由器住在哪里"。

**升级触发器**（任一成立 → 迁移 fork 方向，adapter/broker/UI 部件接口脸不变、全部平移）：
(a) 上游把 `createAgent/resume` 收窄或 `AgentLoop` 封装化；
(b) 路由键必须进 session log 的需求硬了（会话可移植）；
(c) 第三方 runtime 要不依赖我们包独立存在。

---

## 六、里程碑（feature 闭环优先）

1. **M0 继承 PoC**：`CompositeLoop extends AgentLoop` 纯 super 透传 + 安装 patch。验收：`dsh web` 正常起、原生会话全功能、`--dump-config` 行表正确。证明 §3.1 机制成立（go/no-go 闸门）。
2. **M1 feature 闭环**：echo provider（不 spawn 进程，回声翻译成 dsh 事件词汇）+ 路由表 + RPC + chip。验收 = §一行为保证的直接验证：**运行期**切到 echo、会话走 echo、切回 native，全程进程不重启、WS 不断、原生在飞任务不被打断。
3. **M2 OMP provider**：omp-web 桥接部件搬进 RuntimeProvider 形态。验收：OMP 会话在原生 DSH Web UI 全交互（流式、工具卡、cancel、resume）、与原生会话并存互切、宿主重启后断档续播。
4. **M3 第二外来 runtime**（Claude Code 或同类）：验证 `ExternalAgentBase` 泛化性 + broker 对不同进程模型的覆盖。
5. **M4 生态面**：provider 契约文档化 + 第三方可参照 adapter 样例。

每步落 test-report（AGENTS.md 红线 1b），4999 实例 + 测试 profile 隔离（omp-web test profile 先例：`link:` 依赖 + patch 层 `webserver.port=4999`）。

---

## 七、待验证项（代码级，动手前逐条钉死）

1. **继承面编译/运行验证**（M0 即验）：`super.createAgent` 在 rollback 事务、`getTraceable` receiver 追踪、`FactoryOwnership` 归属上与原生实例完全一致——理论多态透明，跑真会话证明。
2. **patch 行 name 重指的准确写法**：`agent-loop` 行在 base bundle `cordis.patch.yml` 的准确 id 与现行 name（守卫值）；确认 bundle patch 不被 live watcher 盯防（watcher 覆盖 = profile 级 + home 级 `cordis.patch.yml`，cordis-customization §2.5）——防御性确认，运行期不依赖。
3. **外来会话的 session 合规**：`ExternalAgentBase` mint session 的 header 必填项、`request/header` 事件校验严格度（seam §六.1；omp-web 的 session-persistence-omp 已有"最小合规 + 自管格式"的实证答案，搬移时核对 alpha.2 变化）。
4. **投递边界并发**：create 与 set-runtime RPC 的竞态；resolve 方向倾向"RPC 请求携带预期 runtime"而非"先建后改"，M1 定。
5. **`agent/status` 与 UI 投影兼容**：外来 agent 经 `agents.register` 正规入册后，session-controller 观察链（`resolveObservedAgent` 只认 registry）与流式渲染路径——omp-web 在产已证大半，搬移时复核。
6. **对齐轮新增查表项**：`AgentLoop` 构造函数副作用清单（settings section、sessionProjections、systemPrompt variables、configured agents 启动链）——子类构造隐式继承，上游加新副作用时评估对路由语义的影响。

---

## 八、源码锚点索引

| 事实 | 位置 |
|---|---|
| `AgentLoop` public class / default export | `packages/core/agent-loop/src/index.ts:359, :916` |
| 构造函数 `setFactory(this)` | 同上 `:420` |
| `AgentFactory` 两方法契约 | `packages/core/agent/src/index.ts:176-210` |
| `create/resume` 的 Reflect.apply 委托（子类透明） | 同上 `:400-420` |
| `AgentOptions` 闭合形状 | `packages/core/agent/src/runtime-types.ts:27-36` |
| controller `agentOptions()` 只填 provider/model | `packages/api/session-controller/src/agent.ts` |
| 单槽 setFactory / disposer / drain | `packages/core/agent/src/index.ts:367-382` |
| patch replace 分支（dispose + 重新 import） | `vendor/loader/src/config/entry.ts:172-287` |
| live watcher 覆盖面（profile/home 级） | `apps/cli/src/profile-boot.ts:283-320` |
| omp-web `OmpProvider implements AgentFactory` | `~/workspaces/dsh-omp/apps/omp-web/src/index.ts:111,128` |
| omp-web 安装期 patch（禁 agent-loop + mount provider） | `~/workspaces/dsh-omp/apps/omp-web/cordis.patch.yml` |
| omp-web 桥接部件清单 | 同仓 `src/{agent,supervisor,rpc,replay,session-persistence-omp,models,permission}.ts` |
