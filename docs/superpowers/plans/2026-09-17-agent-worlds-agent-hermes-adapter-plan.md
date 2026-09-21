# Agent Worlds AW-H：agent-hermes adapter（TUI gateway 线）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 AW-H——`@pgmi-builds/agent-adapter-hermes` 走 agent-codex 已验证的同一插件路径（S2 roster/world/gateway、AW-B mount 形态），经 **TUI gateway JSON-RPC**（`python -m tui_gateway.entry`，stdio ndjson）驱动 Nous Research Hermes Agent v0.21.0，数据面 = omp-web 同构起步（S5），DSH 侧身份映射落 `<dshHome>/agents/hermes/dsh-sessions.json`；**hermes 运行时数据面 = 原生 `~/.hermes`（2026-09-17 user 裁决，不设 `HERMES_HOME`、不建 superd 侧 hermes 数据 home）**，会话存储双份（DSH jsonl log 只承载 DSH WebUI 派生的会话；hermes `state.db` 是原生权威）。

**Architecture:** 拷贝 `apps/agent-worlds/agent-codex/` 的插件骨架（world-plugin → spawnWorld → registerForeignTarget → provider/agent/persistence/preset/permission），把 `CodexSdkClient` 接缝替换为 `HermesGatewayClient`（TUI gateway stdio JSON-RPC 客户端；请求-响应 id 关联 + `method:"event"` 事件流解复用，参照 `ui-tui/src/gatewayClient.ts` 这一上游参考实现）。Gateway 事件（`message.start/delta/complete`、`thinking.delta`、`tool.start/complete`、`status.update`、`session.info/usage`、`approval.request`、`error`）投影到 omp wire 词汇表（`agent_start/turn_start/message_start/message_update/message_end/tool_execution_*/turn_end/agent_end/text_delta`）使 `agent.ts` 以有界 diff 移植。**运行时审批是本线的升级点**：gateway `approval.request` 事件 → Dash `ctx.approval.request()`（ApprovalPanel）→ `approval.respond {choice}`，超时/无应答方一律 deny（fail closed）。

**Tech Stack:** TypeScript（tsc）、`node --test`、Hermes Agent v0.21.0 本机安装（`~/.hermes/hermes-agent`，git install，upstream ad03f20d）+ 其 venv python（`venv/bin/python -m tui_gateway.entry`）、`@pgmi-builds/agent-hub`（file: link）、cordis 4.0.2。**零新 npm 依赖**（协议客户端自研 ~300 行，无 ACP/OpenAI SDK 可用也无需）。

**Spec:**
- `docs/superpowers/plans/2026-09-14-agent-worlds-fusion-design.md`（S1–S7 裁决、AW 形态）
- `apps/agent-worlds/agent-adapter-dev-rules.md`（adapter 定位/两形态/接线域/红线/§12 per-agent 定制权/§13 home 布局）
- `docs/superpowers/plans/2026-09-15-agent-worlds-agent-codex-adapter-plan.md` + 同名 acceptance report（结构蓝本）
- **2026-09-17 user 裁决（本计划的 spec 级输入）**：① 传输面走 **TUI gateway JSON-RPC**（user 在 ACP / TUI gateway / API server 三选一亲选）；② hermes **直接用原生 `~/.hermes`**，不在 superd 下建 hermes 数据 home；③ 会话存储仍然双份（DSH 只留 DSH 派生会话的副本）。
- 协议事实来源（本机实证，非纯文档）：`~/.hermes/hermes-agent/tui_gateway/{entry,server,methods_*,transport}.py`、`ui-tui/src/gatewayClient.ts`（参考客户端）、`ui-tui/src/gatewayTypes.ts`（事件载荷类型全集）、官方 docs 镜像 `.scratch/hermes-docs-fetch/llms-full.txt` §Programmatic Integration。

## Global Constraints

- **Home 裁决（2026-09-17 user）**：adapter 与其 spawn 的 gateway 子进程**一律不设 `HERMES_HOME`**——hermes 读它自己的原生 `~/.hermes`（config.yaml、.env、auth、state.db、sessions/）。adapter 对 `~/.hermes` **只读不写**（单向阀；唯一例外是 hermes runtime 自身经 gateway 写它自己的 state.db/sessions）。adapter 的 DSH 侧状态只有身份映射 `<DSH_HOME>/agents/hermes/dsh-sessions.json`（`<dshHome>/agents/hermes/` 目录同时是 Form-B 世界的 DSH home——该目录是 **DSH 侧**数据，不是 hermes 数据，裁决不影响它）。
- **测试 truth**：live turn 会写进 **prod `~/.hermes`**（与用户的在役 hermes 共享 state.db；WAL+lockguard 多进程安全是 hermes 自身设计）。裁决已接受。纪律：live turn 数量最小化（spike 2 条 + 验收 2-3 条），session title 一律带 `dsh-aw` 前缀，绝不触碰 `~/.hermes/config.yaml` 等配置文件。
- **绝不触碰**：`~/.dsh`、`~/.superd`（DSH prod home）、live Caddyfile。DSH 级 dev/test 一律 `DSH_HOME=/home/u1/workspaces/superd/.superd-test`。
- **会话 cwd 红线**：session cwd = 用户工作区（validated realpath 目录），**绝不指向 `~/.hermes`**，也不指向 `<dshHome>/agents/hermes`。
- **Baseline**：主 checkout（非 worktree；`apps/agent-worlds/` 在 `.git/info/exclude`——线代码不入 git，git 只承载 `docs/` 计划/报告，任务以报告小节为追踪单位）。
- 端口：Form-A 验收口默认 **4985**（4999 = `aw-4999-test` 现役，4998 = 本线默认口让位现役实例，3080/3081 prod）；拉起前 `ss -tln | grep :4985` 预检；daemon 一律 `systemd-run --user`，关停 `systemctl --user stop`。
- 缓存安装：`npm install --cache /home/u1/workspaces/superd/.npm-cache`（沙箱 `~/.npm` EROFS）；exact-pin 无 `^`。install 后单实例检查：`find /home/u1/workspaces/superd/node_modules/@deepseek-ai -maxdepth 1 -mindepth 1 ! -type l`（只应剩本仓自有物理包 `dsh-client-ui-slots`；异常跑 `node scripts/heal-modules.mjs`）。
- 测试约定：`node --test test/*.test.mjs`；测试导入 `dist/`，先 build 后 test；live 测试 env 门控（`HERMES_LIVE=1` 才跑真 gateway）。
- **V1 能力边界（源自 gateway 源码实证，接线表见 §附录 A）**：有 steer（`session.steer`，优于 codex）、有 live 模型目录（`model.options`）、有运行时审批、有原生压缩（`session.compress`）；无 system prompt 透出面（登记 gap）、标题/session.info 仅 log 投影（V1）、plan/todo 事件仅 log（V1）、无 fork（gateway 有 `session.branch`——P2）、usage 走 `message.complete.payload.usage`（可能带一 turn 滞后，与 codex 同判例）。

---

### Task 1: 包骨架 + gateway spike（P0 门）

**Files:**
- Create: `apps/agent-worlds/agent-hermes/package.json`、`tsconfig.json`、`.gitignore`
- Create: `src/spike.ts` + `test/spike.test.mjs`（env 门控 live；Task 7 后删）
- Create: `test/fixtures/`（spike 事件样本落盘处）

**Interfaces:**
- Produces: `@pgmi-builds/agent-adapter-hermes`（exports `.` → `dist/index.js`、`./world` → `dist/world-plugin.js`）；deps `@pgmi-builds/agent-hub: file:../agent-hub`；peerDeps `@deepseek-ai/*` optional（照抄 codex package.json 结构，**无** `@openai/codex*`）；`dsh.bundle.patch: ./cordis.patch.yml`（Task 8 才落地，先占位指向未来文件不报错——`files` 数组含 `cordis.patch.yml`）。

package.json 关键字段（从 agent-codex/package.json 拷贝后改）：

```json
{
  "name": "@pgmi-builds/agent-adapter-hermes",
  "version": "0.0.1-aw",
  "description": "Hermes provider for DeepSeek Harness (dsh) — an AgentFactory that embeds Nous Research Hermes Agent via the TUI gateway JSON-RPC (python -m tui_gateway.entry) and bridges its session surface into Dash Agent/Session contracts (Agent Worlds AW-H).",
  "type": "module",
  "main": "dist/index.js",
  "exports": { ".": "./dist/index.js", "./world": "./dist/world-plugin.js" },
  "scripts": { "build": "tsc -p tsconfig.json", "test": "node --test test/*.test.mjs" },
  "dependencies": { "@pgmi-builds/agent-hub": "file:../agent-hub" },
  "devDependencies": { "@types/node": "^26.2.0", "typescript": "^5.6.0" },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-agent": "0.1.5-rc.2",
    "@deepseek-ai/dsh-agent-presets": "0.1.5-rc.2",
    "@deepseek-ai/dsh-llm": "0.1.5-rc.2",
    "@deepseek-ai/dsh-scope": "0.1.5-rc.2",
    "@deepseek-ai/dsh-session": "0.1.5-rc.2",
    "@deepseek-ai/dsh-session-persistence": "0.1.5-rc.2",
    "@deepseek-ai/dsh-typert-protocol": "0.1.5-rc.2"
  },
  "files": ["dist", "cordis.patch.yml", "README.md"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "private": true,
  "license": "MIT",
  "engines": { "node": ">=22.18" }
}
```

tsconfig.json / .gitignore：逐字拷 `apps/agent-worlds/agent-codex/tsconfig.json`（无改动）。

- [ ] **Step 1: 骨架** — 建三个文件；`cd apps/agent-worlds/agent-hermes && npm install --cache /home/u1/workspaces/superd/.npm-cache` 绿；`npm run build` 绿（空 src/index.ts 占位）；单实例检查零异常。
- [ ] **Step 2: spike（真 gateway，真 turn）** — `src/spike.ts`：解析 hermes root（env `AW_HERMES_ROOT` → `~/.hermes/hermes-agent`）与 python（env `AW_HERMES_PYTHON` → `<root>/venv/bin/python` → `<root>/.venv/bin/python` → PATH `python3`，与 `ui-tui/src/gatewayClient.ts:62-77 resolvePython` 同序），`spawn(python, ['-m','tui_gateway.entry'], { cwd: <scratch cwd>, env: {...process.env}, stdio: ['pipe','pipe','pipe'] })`，按行读 stdout（ndjson）：
  1. 等 `gateway.ready`（15s 超时，TUI 同款）；
  2. `session.create {cwd: <scratch>, title: "dsh-aw spike", cols: 120}` → 记录响应全形；
  3. `prompt.submit {session_id, text: "Reply with exactly: ok"}` → **把此后到回程全静默的完整事件流逐帧落 `test/fixtures/gateway-events.sample.json`**（含时间戳与帧序）；
  4. `session.usage {session_id}`、`session.status {session_id}`、`session.history {session_id}`、`model.options {}` 各记一帧响应样本（同 fixtures，可分文件）；
  5. `session.close` + kill 子进程。
- [ ] **Step 3: 跑 spike（`HERMES_LIVE=1` 门控），样本落盘，as-built 发现记录于本任务下方**
  - 必须从样本中**钉死**：① turn 终止信号（假设：最终 `message.complete`（成功路径无 `status:"error"`，失败路径 `status:"error"`+`error`+`recoverable`+`partial`）+ 后随 `status.update kind=idle`/`session.info`——以实测为准写入 Task 2 映射表）；② `message.complete` 成功载荷全字段（text/usage/rendered/…）；③ `message.delta` 载荷（text 增量字段名）；④ `tool.start`/`tool.complete` 载荷（tc_id/name/args/result 字段名）；⑤ `session.create` 响应（session_id/history/messages/cwd）；⑥ `session.usage` 载荷；⑦ `model.options` 载荷（provider 行/模型行/default）。approval / clarify 不在 spike 触发（依赖用户配置的危险命令审批面），其桥接以单元测试覆盖（Task 7）。
- [ ] **Step 4: docs commit**（线代码不入 git，任务报告即追踪）

---

### Task 2: 事件投影 `src/hermes-events.ts`

**Files:**
- Create: `src/hermes-events.ts`
- Test: `test/hermes-events.test.mjs`（输入 = Task 1 fixtures + 手造边界用例）

**Interfaces:**
- Consumes: gateway 事件帧 `{type, session_id, payload}`（运行时 duck-typed）
- Produces: `projectGatewayEvent(type: string, payload: unknown, ctx: ProjectionCtx): WireEvent | WireEvent[] | null`——投影到 **omp wire 词汇表**（与 codex-events.ts 同一内部词汇）：`agent_start` / `turn_start` / `message_start` / `message_update`(text_delta) / `message_end`（content blocks: text/thinking/toolCall）/ `tool_execution_start` / `tool_execution_end` / `turn_end` / `agent_end`。未知事件 → `null`（ignorable，S5 不变量）。`ProjectionCtx` 由客户端持有（turn 归属与累加态）：`{ turnOpen: boolean; openAssistant: boolean; }`，投影器为**纯函数**，累加态（assistant 文本聚合）由客户端负责——与 codex 投影同等无状态度。

映射基准（Task 1 实测后可修正字段名，结构不变）：

| gateway 事件 | wire 事件 | 说明 |
|---|---|---|
| `message.start` | `message_start {message:{role:"assistant"}}` | 开聚合窗 |
| `message.delta {text}` | `message_update {assistantMessageEvent:{type:"text_delta",delta,index}}` | 流增量 |
| `thinking.delta {text}` / `reasoning.delta {text}` | （累加进 thinking 缓冲，不发 wire） | 折入最终 message_end |
| `tool.start {tc_id,name,args}` | `tool_execution_start {toolCallId,toolName,argumentsJson}` | |
| `tool.complete {tc_id,result,...}` | `tool_execution_end {toolCallId,result:{content,isError}}` | |
| `message.complete {text,usage,status?}` | `message_end {message:{role:"assistant",content:[text,(thinking)]},usage}` +（终止时）`turn_end` + `agent_end` | **turn 边界规则以 Task 1 实测为准** |
| `message.complete {status:"error",error,partial}` | `message_end {message:{role:"assistant",stopReason:"error",errorMessage}}`（failure 由 agent.ts 的 wireFailure 分类） | 复用 codex `wireFailure` 分类器（QUOTA→AUTH→RATE_LIMIT→SERVER） |
| `error {message}` | `agent_end`（异常收尾路径） | 仅在 turn open 时 |
| `session.info` / `session.usage` / `status.update` / `todo.updated` | V1：`null`（log-only 登记项，Task 7 记 trace） | 不进 wire |
| `approval.request` | **不经投影**——客户端直接上报 agent 层回调（见 Task 3/7） | 审批是请求-响应面，不是流 |

- [ ] Step 1: 失败测试（fixture 驱动：每类事件一条断言 + 未知事件 null + error 载荷 + thinking 聚合）
- [ ] Step 2: 跑红 → 实现 → 跑绿 → commit（报告小节）

---

### Task 3: `src/hermes-client.ts`（HermesGatewayClient 接缝）

**Files:**
- Create: `src/hermes-client.ts`
- Test: `test/hermes-client.test.mjs`（fake 子进程注入）+ `test/hermes-client.live.test.mjs`（`HERMES_LIVE=1`）

**Interfaces:**
- Consumes: Task 2 投影器；`ChildProcess` spawn 接缝 `GatewayProcessFactory`（测试注入 fake，仿 codex 的 `setCodexFactory`）
- Produces: `HermesGatewayClient`——公共面与 `CodexSdkClient` 对齐（agent.ts/index.ts 移植面不变）：
  ```ts
  class HermesGatewayClient {
    static spawn(opts: { cwd?: string; env?: Record<string,string> }): HermesGatewayClient
    on(listener: (event: WireEvent) => void): () => void        // wire 词汇
    onApproval(listener: (req: GatewayApprovalRequest) => Promise<GatewayApprovalChoice> | void): () => void
    onFailure(listener: (error: Error) => void): () => void
    ensureStarted(): Promise<void>        // 等 gateway.ready（15s 超时 → reject）
    createSession(opts: { cwd: string; title?: string; model?: string; provider?: string }): Promise<GatewaySessionInfo>
    resumeSession(sessionId: string): Promise<GatewaySessionInfo>   // session.resume；4001/4006 → throw（fail closed）
    prompt(text: string): Promise<void>   // prompt.submit；流事件走 on()
    steer(text: string): Promise<void>    // session.steer
    interrupt(): Promise<void>            // session.interrupt
    compress(): Promise<void>             // session.compress
    history(): Promise<unknown>           // session.history（resume seed 用）
    usage(): Promise<unknown>             // session.usage
    status(): Promise<unknown>            // session.status
    modelOptions(): Promise<unknown>      // model.options（Task 5 catalog 源）
    respondApproval(requestId: string, choice: GatewayApprovalChoice): Promise<void>  // approval.respond
    close(): void                         // session.close（尽力）+ kill 子进程
  }
  type GatewayApprovalChoice = "once" | "always" | "deny";
  type GatewayApprovalRequest = { requestId: string; title: string; command?: string; raw?: unknown };
  ```

实现要点（全部源自上游参考实现 `ui-tui/src/gatewayClient.ts` + gateway 源码实证）：
1. **帧协议**：stdout 按行 ndjson。响应帧 `{jsonrpc,id,result|error}`（id ↔ pending Map 关联；`REQUEST_TIMEOUT_MS=120_000`）；事件帧 `{jsonrpc,method:"event",params:{type,session_id,payload}}`。请求帧 `{jsonrpc:"2.0",id:<自增>,method,params}`。
2. **启动序**：`gateway.ready` 前所有请求入队（`ensureStarted` 守门）；`gateway.stderr`/stderr 数据 → trace；子进程异常退出 → `onFailure` + pending 全拒。
3. **python 解析**（与 TUI 同序）：`AW_HERMES_PYTHON` → `<root>/venv/bin/python` → `<root>/.venv/bin/python` → PATH `python3`；root = `AW_HERMES_ROOT` → `~/.hermes/hermes-agent`。**env 全量透传 `{...process.env}`，绝不注入 `HERMES_HOME`**。
4. **单会话姿态**：一个 client 绑定一个 gateway session（`session.create`/`session.resume` 各调一次）；事件按 `session_id` 过滤（只接受本 session 的帧，其余 trace 后丢弃）。
5. **审批回调**：`approval.request` 事件 → 组装 `GatewayApprovalRequest`（payload 字段名以 Task 7 单测锁定的 `_approval_request_payload` 实测为准）→ 交 `onApproval` 监听者（agent 层桥 Dash approval）→ `approval.respond {session_id, choice, request_id}`。监听者缺位/抛错/超时（30s）→ `deny`（fail closed）。
6. resume 后**回放抑制**：`session.resume` 不带 `defer_history` 时 gateway 可能补发历史事件——客户端在 resume 响应落定前收到的事件全部丢弃（DSH log 是回放权威）；实测若 resume 不发历史帧则在 Task 3 报告记录并简化。
- [ ] Step 1: 失败测试（fake 子进程：ready 序、请求关联、事件解复用、审批回调 deny 缺省、timeout、exit 清理）
- [ ] Step 2: 跑红 → 实现 → 跑绿
- [ ] Step 3: live 冒烟（`HERMES_LIVE=1`：真 gateway + session.create + prompt + 事件回调收到 wire 序列 + close）
- [ ] Step 4: commit（报告小节）

---

### Task 4: `src/hermes-store.ts`（身份映射，"mapping only" 模型）

**Files:**
- Create: `src/hermes-store.ts`
- Test: `test/hermes-store.test.mjs`

**Interfaces:**
- Consumes: 无（纯 fs）
- Produces: 与 codex `session-map.ts` 同构，仅字段与路径不同：
  ```ts
  resolveHermesAppDir(home?: string): string   // <DSH_HOME>/agents/hermes（home 优先 boot 注入，env 兜底）——DSH 侧目录，非 hermes 数据
  sessionMapPath(home?: string): string        // <appDir>/dsh-sessions.json
  readSessionMap(home?): HermesSessionMap
  sessionRecord(home, dshSessionId): HermesSessionRecord | undefined
  upsertSession(home, dshSessionId, patch: Partial<HermesSessionRecord>): HermesSessionRecord
  forgetSession(home, dshSessionId): void
  interface HermesSessionRecord { gatewaySessionId: string | null; cwd: string; createdAt: number; preset: string | null }
  ```
  原子写（temp+rename）、读 fail-soft（坏 JSON → `{}`）、`gatewaySessionId: null` 显式表示"未物化"（首个 prompt 前）。**实现 = 拷贝 `agent-codex/src/session-map.ts` 改字段**（threadId→gatewaySessionId；resolveCodexHome→resolveHermesAppDir）。
- [ ] Step 1: 失败测试（roundtrip / 坏 JSON / null 语义 / forget 幂等）
- [ ] Step 2: 跑红 → 实现 → 跑绿 → commit

---

### Task 5: `src/models.ts`（model.options → 目录）

**Files:**
- Create: `src/models.ts`
- Test: `test/models.test.mjs`（fixture：Task 1 的 model.options 响应样本）

**Interfaces:**
- Consumes: gateway `model.options` 响应（Task 1 样本定字段）
- Produces:
  ```ts
  interface HermesCatalogEntry { id: string; label: string; provider: string; contextWindow?: number }
  interface HermesCatalog { provider: string; models: HermesCatalogEntry[]; defaultModel: string | undefined }
  readHermesModelCatalog(client?: { modelOptions(): Promise<unknown> }): HermesCatalog  // client 缺省或失败 → { provider:"Hermes", models:[], defaultModel: undefined }（占位由上层显式 skip，绝不外流）
  ```
  `id` = 模型选择字符串（`command.dispatch "/model <id>"` 与 `session.create {model}` 可直接消费的原样 id）。`defaultModel` = 响应中的当前选择；不可得 → `undefined`（占位禁外流，dev-rules §6）。**catalog 是异步源**（需 gateway 进程）——Task 7 的 LlmAdapter 用"探针 client + 进程内缓存（TTL 5min）"策略：首个 catalog 查询 spawn 专用 probe client → `model.options` → 关闭。
- [ ] Step 1: 失败测试（样本 → catalog 映射；空/坏响应 → 空目录不抛）
- [ ] Step 2: 跑红 → 实现 → 跑绿 → commit

---

### Task 6: world-plugin + world profile（S2 门，试金石）

**Files:**
- Create: `src/world-plugin.ts`、`src/index.ts`（临时最小导出 `export const name = 'aw.agent-adapter-hermes'; export function apply() {}` 占位，Task 7 实现 provider）
- Test: `test/world-plugin.test.mjs`（仿 `agent-codex/test/` 的 world 测试——若 codex 无独立 world 测试文件则用 hub 侧 audit 模式）

**Interfaces:**
- Produces: `aw.agent-adapter-hermes` world 插件——**逐字拷贝 `agent-codex/src/world-plugin.ts` 改 4 处**：`name='aw.agent-adapter-hermes'`、`KEY='hermes'`、`registerAgent({key:'hermes',label:'Hermes',ready:false})`、`worldHome = join(root,'agents','hermes')`（**注释必须写明**：此目录是世界的 DSH home + 映射文件所在，是 DSH 侧数据；hermes runtime 数据在原生 `~/.hermes`，gateway 子进程 env 不含 `HERMES_HOME`）。
- [ ] Step 1: 拷贝改四处 + build 绿
- [ ] Step 2: spawnWorld 冒烟（`DSH_HOME=<repo>/.superd-test` + `AW_BARE_BASE=<repo>/.superd-test/profiles/node_modules/` 环境三件套；world 起得来、`/hermes` mount 注册、`setReady` 触发）
- [ ] Step 3: commit（报告小节）

---

### Task 7: provider / agent / 衔接层移植（最重，可再切子任务）

**Files:**
- Create: `src/adapter.ts`（LlmAdapter）、`src/agent.ts`（HermesAgent）、`src/index.ts`（HermesProvider）、`src/permission.ts`、`src/inbox.ts`（逐字拷 codex）、`src/agent-preset-hermes.ts`、`src/agent-preset-projection.ts`
- Test: `test/permission.test.mjs`、`test/provider-resume.test.mjs`、`test/agent-preset-roster.test.mjs`

**Interfaces（与 codex 的逐文件 diff 表）:**

| 文件 | 移植方式 | 关键 diff |
|---|---|---|
| `inbox.ts` | **逐字拷贝** | 无 |
| `agent-preset-hermes.ts` / `agent-preset-projection.ts` | 拷贝改名 | preset id `"codex"` → `"hermes"`；roster label `"Hermes"` |
| `adapter.ts` | 拷贝改名 | `CODEX_PROVIDER_ID`→`HERMES_PROVIDER_ID="hermes"`；catalog 源 `readCodexModelCatalog(home)` → **probe-client 缓存的 `readHermesModelCatalog`**（构造参数从 `home` 改为 `() => Promise<HermesCatalog>` 供给函数——目录是异步源）；占位模型显式 skip 逻辑保留 |
| `index.ts` | 拷贝 + 接缝替换 | `CodexProvider`→`HermesProvider`（name `"hermesProvider"`）；`ensureCodexAppHome`/`setCodexHomeResolver` 段**删除**（无 home bootstrap——原生 home 裁决）；`#resolveHome()` 保留（`dshHomePath` boot 注入，映射目录用）；`agentRuntime()` 改造：`systemPrompt` 恒 `undefined`（**登记 gap**：gateway 无系统提示透出面）+ `routeContext` 从缓存的 hermes catalog 取；create 路径 `CodexSdkClient.spawn(...)` → `HermesGatewayClient.spawn()` + **lazy createSession**（spawn 不再是每会话必付——`createAgent` 只落映射 `{gatewaySessionId:null}`，首次 prompt 时 `ensureStarted()+createSession()`；resume 路径 `ensureStarted()+resumeSession(record.gatewaySessionId)`，null/4001 → fail closed 带 Dash id）；`followThreadId` → `followGatewaySessionId`（监听 client 会话物化后 `upsertSession`） |
| `agent.ts` | 拷贝 + 事件 switch 保持 + 交付面改造 | ① wire 词汇 switch 不变（Task 2 已投影）；② `#localUserPending` 恒 false 路径（gateway **不回声** user 消息——`#bridgeRemoteUser`/`userMessageFromWire`/`message_start(role=user)` 分支删除）；③ steer 真 Native：`steer()` → `client.steer(text)`（不再 followUp 近似；`session.steer` 在 idle 时 gateway 侧自行降级为普通 prompt——沿用其语义）；④ followUp → `prompt.submit`（gateway `display.busy_input_mode` 默认 interrupt，**我们绝不在 busy 时 submit**——沿用 `#deliver` 的远端队列 + agent_start flush 时序，busy 提交永远不发生）；⑤ `/compact` 命令**不再 shadow 拒绝**，改注册转发：`handler → client.compress()`（原生压缩面，优于 codex 的 V1 拒绝）；⑥ `/permission` 保持 shadow 拒绝（文案改 hermes：审批走运行时 request/response，预设不可换挡）；⑦ `#syncModelSelection` → `client` 层暂存 + 下一 session.create 参数（V1）+ `command.dispatch {command:"/model <id>"}` 途中切换（若模型目录 id 与 dispatch 语义实测吻合，Task 1 样本定）；⑧ usage：`message_end` 附带 `usage`（gateway 已随 message.complete 送达）→ 直接 `convertUsage`（保留 codex 的 snake_case→camel 转换函数，字段按实测样本对齐）；⑨ 审批桥（**新增，替代 codex 的 launch-only preset**）：`client.onApproval(async req => …)` → `ctx.get("approval").request({agent:this, toolName, callId?, reason, signal})` → `allowed-once→"once"`、`allowed-always→"always"`（选项存在时）、else `"deny"`；无 approval 服务/超时（30s）/抛错 → `"deny"`（**fail closed**；结构仿 omp `#handleExtensionUiRequest`，见 `agent-omp/src/agent.ts:1060-1140`）；⑩ `getSessionStats` 诊断段删除（无此 RPC），`session.usage` 事件 trace 即可 |
| `permission.ts` | **重写（内容最小）** | codex 的 3-preset→`--approval-mode` 映射**删除**（无 launch flag）；保留 `defaultPermissionPreset` / `envApprovalMode`（读法照抄，env 名改 `HERMES_APPROVAL_MODE`，仅作 record 用途）；新增 `approvalChoiceFromOutcome(outcome, options): GatewayApprovalChoice` 纯函数（单测覆盖） |

- [ ] Step 1: permission 纯函数失败测试 → 实现 → 绿
- [ ] Step 2: provider create/resume 失败测试（fake client；映射先 null 后物化；resume fail-closed 路径）→ 移植 index.ts → 绿
- [ ] Step 3: agent.ts 移植 + 投影层联调测试（fixture 回放：client fake 重放 Task 1 事件样本 → 断言 session 事件落点序：turn/start、user/message、assistant/message(+stream records)、tool/call|result、turn/end、status、agent-preset/selected）
- [ ] Step 4: `npm run build && npm test` 全绿（专属 env：`DSH_HOME=<repo>/.superd-test`、`AW_BARE_BASE=<repo>/.superd-test/profiles/node_modules/`）
- [ ] Step 5: commit（报告小节）

---

### Task 8: cordis.patch.yml + standalone profile + start 脚本

**Files:**
- Create: `apps/agent-worlds/agent-hermes/cordis.patch.yml`、`scripts/setup-hermes-profile.mjs`、`apps/agent-worlds/test/start-hermes-app.sh`

**Interfaces:**
- `cordis.patch.yml` = 逐字拷 codex 版改：insert row `id: hermes-provider / name: '@pgmi-builds/agent-adapter-hermes'`；disable `agent-loop`、`llm-deepseek`、`llm-pi-ai`、`agent-presets`；**保留** upstream jsonl persistence 注释与 `permission` 3-preset 表（`defaultPreset: danger-full-access`——hermes 审批走运行时面，此预设仅是 DSH approval 服务默认档 + UI 呈现）；`directory-picker-browse` pin 段照抄。
- `setup-hermes-profile.mjs`（仿 `scripts/profiles/*.mjs` 幂等 bootstrap）：生成 `$DSH_HOME/profiles/hermes-standalone/`（package.json bundles = base + web-app + hermes bundle；cordis.patch.yml 写 `webserver.port: 4985`）+ 链 `@pgmi-builds/agent-adapter-hermes` link。
- `start-hermes-app.sh`（仿 `start-codex-app.sh`）：端口预检（4985）→ bootstrap → `systemd-run --user --unit=hermes-4985-test -p WorkingDirectory=<repo> -p Environment=DSH_HOME=<repo>/.superd-test -p Environment=PATH=… -p StandardOutput/Error=append:.scratch/hermes-4985.log <node> <repo>/upstream/deepseek-harness/apps/cli/lib/bin.js --profile hermes-standalone --no-open` → 轮询 + token 提取（水位法）→ 打印 URL。

- [ ] Step 1: 三文件落地；bootstrap 幂等重跑验证
- [ ] Step 2: **Form-A 起服**（沙箱红线：一律 `systemd-run --user`，勿从 agent bash 直拉）→ `curl -c jar -L '<token-url>'` 冒烟 → GET `/` 401 fence 验证
- [ ] Step 3: 单实例检查 + commit（报告小节）

---

### Task 9: 第一人称验收（repo 纪律）

**Files:**
- Create: `docs/superpowers/plans/2026-09-17-agent-hermes-4985-acceptance-report.md`

- [ ] **Step 1: 真 runtime turn（运行时行为验收，非构建卫生）**：浏览器（WebUI）建 hermes 会话 → 真实 prompt → assistant 流式回复上屏；HTTP wire 面：`POST /api/<ns>/<method>` envelope `{type:"client-request",rpcId,method,payload}` create→prompt→readback 走通。
- [ ] **Step 2: 会话生命周期**：重启 dsh 实例 → list/replay 由 DSH log 提供 → resume 经映射重挂 gateway 会话（历史来自 DSH seed，无重复回放）；kill gateway 子进程（模拟崩溃）→ 下一个 prompt 冷恢复。
- [ ] **Step 3: 审批链**：触发一个 hermes 运行时审批（视用户 config 而定；不可触发则以单测 + trace 证据登记）→ Dash ApprovalPanel 出卡 → once/deny 语义正确、超时 deny。
- [ ] **Step 4: 模型面**：selector 列出 `hermes` 路由真目录；切换生效（新会话或途中，如实记录）。
- [ ] **Step 5: 验收报告落 docs + 用户亲手测试**（**起了 Web 服务器就停下来交给 user，保持运行**，等用户测完再收尾——验收模式 user 裁决 2026-09-09）。服务器保持：`hermes-4985-test` unit 不 stop；报告给 local URL + token。
- [ ] Step 6: user 放行后：`npm publish` 前置三闸门核对（本包 private，不 publish——此条仅记录流程不触发）。

---

## 附录 A：接线域清单（dev-rules §3 对照，V1 as-planned）

| 接线域 | 供给方 | V1 裁决 |
|---|---|---|
| spawn / resume | gateway `session.create` / `session.resume` | lazy 物化（首 prompt）；resume fail-closed（映射缺失/4001/4006） |
| events → dsh | gateway 事件 → Task 2 投影 → codex 同款 agent.ts | 全覆盖：user/assistant/thinking/tool/turn 生命周期 + error 分类（wireFailure 平移） |
| 审批 / 交互 | `approval.request` ↔ `approval.respond` | **真运行时审批**（超 codex launch-only）；clarify/sudo/secret V1 → deny/cancel（fail closed，登记 P2） |
| model list / 切换 | `model.options` + `session.create{model}` + `command.dispatch "/model"` | 目录=运行时真 inventory；切换语义（途中 vs 下轮）以实测为准记录 |
| cwd / workspace | `session.create {cwd}`（显式每会话） | cwd=用户工作区 realpath；红线不指 `~/.hermes` |
| slash / commands | gateway 原生处理 prompt 内 slash | `/compact`→`session.compress`；`/permission` shadow 拒绝；其余 passthrough |
| compaction | `session.compress` + `status.update{kind:"compacting"}` | 压缩指示 log-only（V1），compaction 事件词汇登记 P2 |
| token usage | `message.complete{usage}` / `session.usage` | 随 assistant/message 落账（可能一 turn 滞后，与 codex 同） |
| session metadata | DSH log 权威 + `session.info` | 标题/info V1 log-only（登记 P2） |
| system prompt | **无透出面** | 未接（登记 P2——hermes 不经线暴露系统提示） |
| app-wide settings | 无（单向阀：adapter 不写 `~/.hermes`） | 默认模型推送 `agentDefaultModel` ← catalog default（codex 同款 settings.replace 直写路径） |
| fork | gateway `session.branch` 存在 | V1 fail 拒绝（与 codex create 路径 parentSession 拒绝同款），P2 接 |
| subagent | gateway `subagent.*` 事件族 | V1 log-only（登记 P2） |
| readiness | python 解析 + `gateway.ready` 15s | 失败 fail-soft + logger 留痕（dev-rules §6） |

## 附录 B：自评审记录（writing-plans self-review）

- **Spec coverage**：user 三裁决（TUI gateway / 原生 home / 双份存储）分别落在 Architecture、Global Constraints 1、Architecture+Task 4；dev-rules 接线域逐项入附录 A（未接项显式登记）。
- **Placeholder scan**：字段名以"Task 1 实测钉死"为显式动作项（spike 是任务而非 TBD）；无 "TBD/TODO" 文案。
- **Type consistency**：`HermesGatewayClient` 公共面在 Task 3 定义、Task 5/7 消费处签名一致；`GatewayApprovalChoice` 两处同名同形；`HermesSessionRecord.gatewaySessionId` 与 codex `threadId` 语义一一对应。
