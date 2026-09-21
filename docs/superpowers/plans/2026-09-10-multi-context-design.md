# 从 Multi-Agent 到 Multi-Context：多 Runtime Context 强隔离与 BFF 导流门架构蓝图

- **日期**: 2026-09-10
- **定位**: 架构设计文档（从 Multi-Agent 单槽修补演进至 Multi-Context 多容器强隔离）
- **路径**: `docs/superpowers/plans/2026-09-10-multi-context-design.md`
- **核心命题**: **“与其叫 Multi-Agent，不如叫 Multi-Context”** —— 不在单 Context 内修补多槽 Agent Loop，而是在 App 入口主动 Spawn 多个独立的 Cordis Context（`CTX 0..N`），以 `CTX 0` 作为 Native 完整体与 App Web UI 载体，跨 Context 构建 BFF 导流门。

---

## 〇、架构核心变迁

| 维度 | 旧构想 (Multi-Agent 修补) | 新蓝图 (Multi-Context 多容器) |
|---|---|---|
| **基本单位** | 单 Context (`ctx`) 下的 `AgentRegistry` 多槽分流 | 多独立 Context (`CTX 0`, `CTX 1`, `CTX 2`...) 平行共存 |
| **隔离级别** | 共享 Root DI 树，服务相互覆盖抢占 | Context 级别强隔离，各拥有独立 Service Tree 与 Fiber Timeline |
| **BFF 数据面** | 异构 Adapter 覆盖根 `sessionPersistence` 造成全局污染 | `CTX 0` BFF 导流门跨 Context 聚合/路由数据面 |
| **切换代价** | 容易误触 patch 热重载或 HMR，杀掉在飞任务 | 各 Context Fiber 常驻不卸载，Selector 仅翻转导流门指针（Zero HMR / Zero Drain） |

---

## 一、反面案例与避坑推演（Negative Examples & Pitfalls）

### 1. 陷阱一：仅在 `AgentRegistry` / `AgentLoop` 搞多槽，忽略根服务单例溢出

- **现象**: `MultiAgentRegistry` 实现了 `createAgent/resume` 的分流，但引入 `agent-omp-sdk` 后：
  1. Workspace 会话列表全部变成 OMP 的会话；
  2. Chat 的模型下拉菜单恒为 Native DSH 模型；
  3. 新建会话始终落入 Native Loop 接管。
- **根因分析**: Cordis 进程级 `Context` 是**单例服务树 (Root Singleton DI Tree)**。外来 Adapter（如 `agent-omp-sdk`）为了提供会话能力，在根 `ctx` 上 `provide('sessionPersistence', ompStore)`，直接覆盖了 Native DSH 的全局持久化服务。
- **结论**: `AgentRegistry` 位于链路末端（仅管 Agent 实例创建），**无法隔离上游 BFF 数据面 (`/api/sessions`, `/api/models`)**。在单一 Context 里强行揉入异构 Runtime 必然导致服务抢占与全局数据污染。

### 2. 陷阱二：运行期触碰 `cordis.patch.yml` 触发 HMR

- **现象**: 尝试在用户点击切换 Selector 时动态修改/翻转 `cordis.patch.yml`。
- **后果**: 触发 DSH 的 watcher 与 `cordis-plugin-hmr` ➔ 原地重载受影响 Fiber ➔ 执行 `effect` 清理 ➔ **强制 Drain 并 Kill 内存中正在运行的 Agent 任务与子进程**。
- **结论**: Cordis Patch / HMR 是**开发期/部署期安装机制**，绝不能暴露在用户运行期路径上。运行时切换必须是纯粹的指针/路由写入，零 HMR、零 Drain、零进程死亡。

### 3. 陷阱三：混淆 Cordis Context 与 DSH Scope (作用域)

- **现象**: 试图利用 `dsh-scope` (`createScope`) 来实现异构 Runtime 的隔离。
- **根因分析**:
  - `dsh-scope` 是 **单 Agent 实例级的指令/Preset 沙箱 (Per-Agent Execution Sandbox)**，生命周期始于 `createAgent` 之后。
  - BFF 数据面（如 Web UI 未选会话时拉取 `/api/sessions` 或 `/api/models`）发生在 **Agent 创建之前**。Scope 属于下游叶子节点，无法向上覆盖全局 HTTP/RPC 接口。

---

## 二、Multi-Context 核心蓝图（Core Blueprint）

```
[SuperD App / CLI 入口 (抢占控制权)]
  │
  ├─► CTX 0 (Native Context - 完整体 & 宿主载体)
  │     ├── WebServer (独占 HTTP/WS 端口: 4999 / 3090)
  │     ├── Native Web UI 静态 Bundle 挂载 & Auth 栅栏
  │     ├── Native DSH Service Tree (llm, sessions, agents, sessionQuery...)
  │     └── BFF Cross-Context Dispatcher (导流门中枢)
  │
  ├─► CTX 1 (Foreign Context - OMP)
  │     ├── WebServer Disabled (关闭重复端口与 UI 挂载)
  │     ├── OMP Agent Adapter & OMP Bridge-Store
  │     └── 独立 OMP Fiber Timeline (常驻运行)
  │
  └─► CTX N (Foreign Context - Claude / Codex...)
        ├── WebServer Disabled
        └── 独立 Runtime Adapter & Fiber Timeline
```

### 1. (a) 抢占入口 (Preempting the Entry Point)

- **机制**: SuperD App CLI 作为第一启动入口（不修改上游 `deepseek-harness` 源码）。
- **职责**: 在单个 Node.js 进程启动时，由 SuperD 主动实例化并管理多个平行 Cordis Context（`const ctx0 = new Context(); const ctx1 = new Context();`）。

### 2. (b) 独立 Spawn 多 Context (Multi-Context Spawning)

- 在同一进程内，显式拉起 `CTX 0`, `CTX 1`, `CTX 2` ... `CTX N`。
- 每个 Context 拥有自己**完全独立的 Service Tree 与 Fiber Timeline**。
- `CTX 1` 重写 `sessionPersistence` 仅对其自身子树可见，从物理上杜绝对 `CTX 0` 的服务污染。

### 3. (c) CTX 0 完整体 ↔ CTX 1..N 裁切定制体 (Asymmetric Context Roles)

- **CTX 0 (Native Primary Context)**:
  - 跑全量 Native DSH 服务树，所有原生组件默认全部 Active。
  - 作为基础生态底座，确保 Native 功能 100% 完备。
- **CTX 1..N (Foreign Custom Contexts)**:
  - 随意定制、裁切与 Patch。
  - **显式 Disable 掉 WebServer、重复的 HTTP 端口与 UI 挂载**。
  - 仅保留该异构 Runtime（如 OMP/Claude）所必需的 Adapter、进程 Broker 与持久化服务。

### 4. (d) App 载体与 BFF 导流门放在 CTX 0 上 (Carrier & Dispatcher)

- **App 载体**: `CTX 0` 是唯一向外暴露 Web Server (端口 4999)、Web UI 静态资源与 Typert RPC 栅栏的真实载体。
- **前端复用**: Web UI 完全复用 `CTX 0` 构建出来的原生界面，利用前端自身的自愈与宽容度展示数据。
- **BFF 导流门 (Cross-Context Dispatcher)**: 在 `CTX 0` 的 BFF 接入面（`session-controller` / Typert RPC）构建跨 Context 导流代理：

```ts
// BFF 导流门逻辑示意
class CrossContextBffDispatcher {
  // 1. Workspace 会话列表：跨 Context 聚合
  async listSessions(): Promise<SessionSummary[]> {
    const nativeSessions = await ctx0.get('sessionQuery').listSessions()
    const ompSessions = await ctx1.get('sessionQuery').listSessions()
    return [...nativeSessions, ...ompSessions]
  }

  // 2. Chat 模型清单：根据 Selector 当前 activeRuntime 路由
  async getModelCatalog(activeRuntime: string): Promise<ModelCatalog> {
    if (activeRuntime === 'omp') {
      return ctx1.get('ompProvider').listModels()
    }
    return buildModelCatalog(ctx0) // Native
  }

  // 3. 消息投递与 Agent 创建：根据 sessionId 路由键跨 Context 派发
  async createAgent(sessionId: string, options: CreateOptions): Promise<AgentHandle> {
    const targetCtx = resolveContextByRuntime(options.runtime) // ctx0 | ctx1
    return targetCtx.get('agents').create(options)
  }
}
```

---

## 三、架构优势与红线保证

1. **绝对服务隔离**: 异构 Runtime 无论如何重写 Service，均封印在各自的 `CTX N` 内，零污染 `CTX 0`。
2. **零 HMR ↔ 零 Drain 保证**: `CTX 0..N` 的 Fiber Timeline 在进程内常驻。切换 Selector 仅改变 `CTX 0` 导流门的指针方向，后台任何正在运行的 Agent 轮次与子进程均不受打扰（开灯/关灯比喻）。
3. **上游源码零修改**: `upstream/deepseek-harness` 保持 Exact-Pin 只读。所有 Context 衍生、裁切与跨 Context 导流逻辑均落于 `superd` 自有包内。

---

## 四、已验证事实（2026-09-10 PoC）

> 源码依据：`upstream/deepseek-harness/packages/boot/app-boot/src/index.ts`（`boot()`，L793 起）、`packages/boot/cmdline`、`apps/cli/src/profile-boot.ts`、`packages/api/session-controller/src/index.ts`。实证脚本：`.scratch/multi-context-poc/`（`node poc.mjs` 全绿）。

### 1. boot() 与 new Context() 的时序关系（澄清）

`boot()` **内部包含** `new Context()`，不是它的前置：`new Context()` → `ctx.plugin(Loader)` → `prepare(ctx)`（host 钩子）→ `mountRootInclude(config)` → `assertEntriesActivated`。二者拿到的是同一个真正的 Context 实例，区别仅在“是否带标准挂载编排”。所谓“boot 早于 Cordis 进场”只对**进程第一个** Context 成立；第二个 Context 由 ctx0 内插件调用时，cordis 模块已在进程内加载，`new Context()` 用的是同一模块实例的同一类，`Symbol.for` 品牌、服务 store 机制全同源——不存在“普通 JS 寻址空间 vs Cordis Symbol 空间”的割裂。

### 2. 单进程多 root Context：实证通过

| 命题 | 结果 |
|---|---|
| ctx0 内插件 spawn 平级 root ctx1 | ✅ `ctx0 === ctx1` 为 `false` |
| 独立 registry | ✅ 两个 root 的 `fiber.uid` 均为 `0`（各自 registry 的根），`loader` 服务实例不同 |
| 跨 Context 直接取服务 | ✅ `ctx1.get('…')` 直接返回 ctx1 服务实例（同进程共享事件循环） |
| 服务 store 强隔离 | ✅ `ctx0.get('ctx1 的 service')` 与反向均为 `undefined`，零泄漏 |

**结论**：ctx1 **不是** ctx0 的 DI 子树（`extend`/`isolate`），而是进程内平级 root 树；插件对两者的关联仅是“持有引用”。这正是陷阱一所要求的物理隔离强度。

### 3. 落计划前必须遵守的两条实现约束

1. **ctx1..N 绝不能走 `runProfile()`**，必须直调 `boot()`。`runProfile()` 会装进程级 `process.on('SIGTERM'/'SIGINT')` 与 `installFailLoud(NAME, process, …)`，重复调用会冲突（上游 fail-loud 切片是可注入的，测试即如此绕开 process）。
2. **`dshHomePath` 是共享解析器**：`boot()` 无条件 `ctx.provide('dshHomePath', dshHomePath)`，而该函数每次调用都重新 `resolveDshHome()`（读 `process.env.DSH_HOME`）。PoC 实测两 root 拿到的 `dshHomePath` 是**同一函数引用**。多 Context 若要各自独立 home，不能改 `process.env`（会连累 ctx0），必须**在各自树内覆盖 `dshHomePath` 服务**（`boot` 已 provide，`provide` 同 scope 重复会 throw——需在 `mountRootInclude` 之前用自有 `prepare`/手动编排路径处理，或对 ctx1..N 接受共享 home + per-profile 隔离）。

### 4. BFF 导流门接入点已确认

`session-controller` 落点是 `packages/api/session-controller/src/index.ts` 的 `SessionController extends TypertRemoteService`，`super(ctx, 'sessionController', { namespace: 'session' })`——即 `ctx.remote.session` 命名空间所有者（Typert RPC 网关）。其 `inject` 面为 `agents / sessions / llm / sessionQuery / typert / workspaceRegistry / …`，会话列表经 `ApiSessionList` 调 `ctx.sessionQuery.listSessions`。

→ superd 的 BFF 导流 = **组合层 patch 替换 `sessionController` 行**（superd-web-bundle 已有 roster patch 机制），替换为按 Selector 路由到 ctx0 / ctxN 服务的导流版本；Selector 切换仅翻转导流门持有的指针，零 HMR、零 Drain。

### 5. 遗留待决

- **ADR 0008（进程模型）**：已定案 → `docs/adr/0008-multi-context-process-model.md`（foreign 子进程 / native 多 Context 同进程；三条实现约束）。
- **ctx1..N 的独立 home 覆盖路径**：约束 2 的具体落地姿势（prepare 前覆盖 vs 共享 home）需在 P 计划里定。
- **裁切 composition 的最小行表**：已解（见 §6）。

### 6. ctx1..N 最小行表 = `dsh-base` 单 bundle（已验证）

`web` profile 模板 = `bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']`（`profile.ts` 的 `PROFILE_TEMPLATES.web`）。**去掉 `dsh-web-app` 即得 ctx1..N 的最小配置**——无需去试探 headless 等其他 profile 各含什么。

实测（`.superd-test/profiles/ctx1-min/`，`package.json` 只写 `dsh.profile.bundles: ['@deepseek-ai/dsh-base']`，`DSH_HOME=.superd-test dsh --profile ctx1-min --dump-config`）：

- **共 84 行**，`webserver` / `frontend-static` / `web-app` / `session-controller` 行全部 **NONE**；
- 全套服务树在位：`llm` / `session` / `agent-loop` / `tools` / `system-prompt` / `subagent`（spawn+in-process+fork）/ `session-query-sqlite` / `typert`+`typert-gateway` / `storage` / `credentials` / `settings` 等；
- 84 行里无任何绑定 HTTP 端口、无 UI 挂载——天然满足“裁切体”要求。

**关键结构事实**：`session-controller`（BFF 的 `ctx.remote.session` 命名空间）挂在 **dsh-web-app**（其 `cordis.patch.yml` L105），**不在 dsh-base**；`typert-gateway`（`@deepseek-ai/dsh-api-gateway`）才在 dsh-base。→ 这意味着 **session-controller 天然只属于 ctx0**（唯一 web 载体），ctx1..N 不需要它，BFF 导流门在 ctx0 的 session-controller 里跨 Context 聚合即可，与设计意图完全吻合。

**profile 是否可预写 YAML 现场加载**：可以，且 superd 已在用（`scripts/m0-profile.mjs` 就是预写 profile 目录 = `package.json`（bundles 行表）+ `cordis.patch.yml`（行 patch））。spawn 时 `loadProfile`/`composeProfile` 解析 bundle 名 → 其 `cordis.patch.yml` 行 → `boot()` 挂载。**推荐引用 bundle 名（`@deepseek-ai/dsh-base`）而非手抄 84 行**：上游每发版 bundle 行自动跟随（对齐纪律 §二），手抄会漂移。

### 7. 真实 dsh-base 树同进程 spawn：PoC v2 实证

`loadProfile` + `boot` 编程式 spawn（`.scratch/multi-context-poc/poc2.mjs`，`spawner2.mjs` 为 ctx0 插件）已全绿：

| 命题 | 结果 |
|---|---|
| ctx0 插件 spawn 平级 root ctx1 | ✅ `ctx0 === ctx1` → `false` |
| ctx1 服务面完整 | ✅ `llm`/`sessions`/`agents`/`agentLoop`/`tools`/`systemPrompt`/`sessionQuery`/`typert`/`subagents`/`sessionPersistence` 全 present |
| ctx1 无 web 面 | ✅ `webServer`/`sessionController`/`frontendStatic` 全 absent |
| 跨 Context 直调 | ✅ `ctx1.get('sessionQuery').listSessions` 是函数 |
| 服务 store 隔离 | ✅ 双向 get 对方服务均 `undefined` |

**新增发现（模块解析闭包）**：spawn 真实 dsh-base 树需要完整 `@deepseek-ai/*` 闭包可从宿主 node_modules 解析。sandbox 内 Node 内部 ESM loader 不可达，`boot()` 第 5 参 `bareModuleBaseUrl` 惰性（bare 名回退普通 `import()` 从 superd/node_modules 解析）。PoC v2 以 symlink 补齐 180 个包跑通；**正式落地 = superd `package.json` 精确 pin 完整闭包**（或复用 dsh install 的 profile `node_modules` fallback），见 ADR 0008 约束 3。


---

## 五、Selector 数据面纯净性裁决（2026-09-10 user 裁决，升格为不变量）

> 本节裁决修订 §四.6 的"最小行表 = dsh-base 单 bundle"结论（该结论在"按键取服务"前提下成立，已被本节取代），并否定 union persistence 方向。

### 1. 不变量：UI = 被选中 runtime 自有数据的纯净投影

**UI 呈现的整个数据面 = 当前被选中 runtime 的自有数据，不混、不合、不打标签。superd 在 UI 上拥有的数据段有且只有一个：selector。**

否决 union session listing 的完整灾难链（推导保留）：

1. **第二选择权威**：列表 item 的 runtime 归属成为隐式 selector，与显式 selector 按钮打架（按钮说 native、用户点 OMP item，听谁的？）——控制面从单点变分布式。
2. **路由键传染**：per-item 归属标记必须贯穿 `prompt`/`history`/`follow`/`cancel` 全部读写路径——被搁置路线的 ownsSession 归属问题换马甲复活。
3. **UI O(N) 侵入**：上游 dumb carrier 要渲染 foreign 命名空间标签，每加一个 runtime 加一层 UI patch，违反"浏览器端原生不动"。
4. **混流病复发**：单 Context 时代的"清单恒 OMP / 目录恒 native"病灶从服务层挪到呈现层，病没好。

### 2. 导流统一到 remote service 层（否决"按键取服务"）

- selector = native → 导给 **CTX0 的 remote service**；selector = foreign → 导给 **CTX1 的 remote service**。
- 分流器只认一个接口（typed RPC 面）；各 context 有哪些服务、缺哪些（如 settings 未接）是 **adapter 自己的职责**，分流器零感知。
- CTX1..N 保持**完整 web 面**：web profile 形态 + adapter 行，webserver 绑专属 loopback 端口（308x，不对用户暴露），整条数据流管道常驻 ready。

### 3. 进程摆位正交化（ADR 0008 修订）

导流发生在 wire 层后，**CTX1 是同进程 `boot()` 出的、还是独立进程，对分流器不可见**：今天生产跑在 3081 的 omp-web 实例与进程内 boot() 绑 3081 的 CTX1 是同构 interchangeable 目标，且复用 ADR 0007 已验证的 loopback cookie-jar 转发（服务端持 cookie，loopback Host 过信任栅栏）。同进程 CTX1 / 本机独立进程 / 远端 machine 三类目标走同一套转发代码——进程摆位降级为部署细节。

### 4. adapter 回退 exclusive 形态

- `agent-omp-sdk` 的 `OmpUnionSessionPersistence`（JSONL ∪ OMP store）回退为 **OMP-store-only 扫描**——union 是 Context 分不开时代的妥协，独立 omp-web-sdk 形态本就只扫 OMP store。
- 工厂注册回到 `setFactory` 独占槽（= omp-web 生产形态）；CTX1 是专属 foreign context，独占不再是 hack 而是正当裁切。CTX1 组合 ≈ 生产 omp-web 同构体，adapter 改造量趋近于零。

### 5. 实现注意（验证阶段处理）

- web-app 行从 `webStartup`/`cmdlineArgs` 取 bind 值；直接 `boot()` 不经 `runProfile` 时不提供这两个服务则 **no server binds**——CTX1 spawn 需在 `prepare` 钩子喂端口参数。
- ADR 0008 约束 1/2（不走 `runProfile`、`dshHomePath` 共享解析）不变。

