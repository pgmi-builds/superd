# Multi-Context 进程模型：foreign 走子进程，native 多 Context 同进程

2026-09-10 accepted（multi-context 设计 `docs/superpowers/plans/2026-09-10-multi-context-design.md` §四/§六 实证后定案）

## 决策

**Foreign runtime（OMP / Claude Code / Codex）一律作为子进程 spawn；superd 自有的 native Context（CTX 0 + 按需拉起的 CTX 1..N）运行在同一个 Node 进程内，经公开的 `boot()` 库函数派生为平级 root Context。**

分界依据是 runtime 的**所有权**，不是性能或 IPC 偏好：

- **Foreign = 子进程是现实，不是取舍**。OMP、Claude Code、Codex 是外部已运行的 runtime，除了 `spawn`（`omp --mode rpc` / `claude -p` / `codex exec`）没有第二条路；拆源码并进来并执行不成立。adapter 壳随 host 常驻（很薄），真正 on-demand 的是子进程，首次有会话路由到该 runtime 才 spawn（沿用 multi-agent-registry 档案 §三的 broker 托管结论）。
- **Native 多 Context = 同进程是机制可行的正解**。CTX 0 必须与 superd 的 BFF 导流门、插件核心同进程，才能拿到核心级运行时状态（直接 `ctx1.get(...)` 调服务、共享事件循环）；子进程 + IPC 会退化为"体验不一样"的远端数据面。

## 同进程 multi-context 的机制（实证）

CTX 0 是 superd 的 web 载体（`dsh-base` + `dsh-web-app`），superd 插件作为 CTX 0 树上的一个节点，在激活时调用公开库 `loadProfile` + `boot`（`@deepseek-ai/dsh-app-boot`）派生**平级 root Context**（非 `extend`/`isolate` 子树）：

```js
const profile = loadProfile('superd-ctx1', 'ctx1-min', DSH_INSTALL_ANCHOR, home)
const ctx1 = await boot('superd-ctx1', cordisYmlPath, [...profile.layers.flatMap(l => l.patches)], undefined, bareModuleBaseUrl)
```

PoC（`.scratch/multi-context-poc/poc2.mjs`）全绿：

- `ctx0 === ctx1` → `false`；两个 root 的 `fiber.uid` 均为 `0`（各自 registry 的根）。
- 服务 store 强隔离：`ctx0.get('ctx1 的 service')` 与反向均为 `undefined`，零泄漏。
- 跨 Context 直调：`ctx1.get('sessionQuery').listSessions` 是函数（导流门前提成立）。
- 最小行表 = `dsh-base` 单 bundle（84 行）：`llm/sessions/agents/agentLoop/tools/systemPrompt/sessionQuery/typert/subagents` 全在位；`webServer/sessionController/frontendStatic` 全部 absent。

## 三条实现约束（红线）

1. **CTX 1..N 绝不走 `runProfile()`**，只走 `boot()`。`runProfile()` 装进程级 `process.on('SIGTERM'/'SIGINT')` 与 `installFailLoud(process, …)`，重复调用必冲突。
2. **`dshHomePath` 是共享解析器**：`boot()` 无条件 `provide('dshHomePath', dshHomePath)`，该函数每次调用重读 `process.env.DSH_HOME`。多 Context 独立 home 只能覆盖各树内 `dshHomePath` 服务，不能改 `process.env`（连累 CTX 0）。
3. **完整插件闭包必须可从宿主 node_modules 解析**：sandbox 内 Node 内部 ESM loader 不可达，`bareModuleBaseUrl` 惰性（bare 名回退普通 `import()` 从 superd/node_modules 解析）。稳妥路径 = superd 精确 pin 完整 `@deepseek-ai/*` 闭包（本仓库 `package.json` 声明"root dev tree 共享全部 direction 包"已含此意），或复用 dsh install 的 profile `node_modules` fallback。

## 关键结构事实（导流门落点）

`session-controller`（BFF 的 `ctx.remote.session` Typert 命名空间，`SessionController extends TypertRemoteService`）挂在 **dsh-web-app**（其 `cordis.patch.yml` L105），不在 dsh-base；`typert-gateway`（`@deepseek-ai/dsh-api-gateway`）在 dsh-base。→ session-controller 天然只属于 CTX 0（唯一 web 载体），BFF 导流门落在 CTX 0 的 session-controller 里跨 Context 聚合/路由；CTX 1..N 不需要它。

## Consequences

- foreign 会话经 CTX 0 的 BFF 导流门路由到对应子进程 adapter；子进程崩溃不拖垮 host（进程边界即故障域边界）。
- native 多 Context 常驻、Selector 切换仅翻转导流门指针，零 HMR、零 Drain、零进程死亡（陷阱二红线守住）。
- superd 的 `package.json` 需补齐完整闭包（或走 dsh install 的 profile node_modules fallback）——对齐轮（AGENTS.md §二）换 pin 时该闭包与上游 bundle 行同步跟进。
- 取代 multi-agent-registry 路线（已 SHELVED）：不再在单 Context 内 patch `AgentRegistry` 多槽，隔离从"factory 级"上移到"Context 级"，服务面单例污染问题物理消失。
