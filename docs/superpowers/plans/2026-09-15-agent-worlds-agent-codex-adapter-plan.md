# Agent Worlds AW-E：agent-codex adapter（SDK 线）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 AW-E——`@pgmi-builds/agent-adapter-codex` 走 agent-omp 已验证的同一插件路径（S2 roster/world/gateway），经 **`@openai/codex-sdk`** 驱动 Codex CLI 子进程，数据面 = omp-web 同构起步（S5），嵌套 home `<dshHomePath>/agents/codex`（S7）。

**Architecture:** 拷贝 `apps/agent-worlds/agent-omp/` 的插件骨架（world-plugin → spawnWorld → registerForeignTarget → provider/agent/persistence/preset/permission），把 OMP SDK client 接缝替换为 `CodexSdkClient`（`@openai/codex-sdk`，每会话一个 thread handle，事件流投影到 omp wire 词汇表使 `agent.ts` 最小差异移植）。Codex 原生件（rollout JSONL 扫描、config.toml/model_catalog 模型目录、sandbox/approval 3-preset 映射）自冻结线 `apps/multi-agent-ctx/agent-codex/` 拷贝改造——拷贝不耦合。app-server B 线（2026-09-10 计划主案）不在本计划范围；同一 client 接缝留作后续 mode。

**Tech Stack:** TypeScript（tsc）、`node --test`、`@openai/codex-sdk@0.154.0` + `@openai/codex@0.154.0`（exact-pin）、`@pgmi-builds/agent-hub`（file: link）、cordis 4.0.2。

**Spec:**
- `docs/superpowers/plans/2026-09-14-agent-worlds-fusion-design.md`（S1–S7 裁决、§十二 AW-E）
- `docs/superpowers/plans/2026-09-10-agent-codex-dev-plan.md`（Codex 本机实测事实、SDK 能力缺口表、同核双壳结论——其 B 线裁决属旧线，本计划按 user 2026-09-15 裁决改走 SDK 线）
- `apps/agent-worlds/AGENTS.md`（本线不变量与运维红线）

## Global Constraints

- **Worktree 姿态（2026-09-15 user 裁决）**：全部工作在 `/home/u1/workspaces/superd/.scratch/aw-codex/`（branch `aw-codex-adapter`）。`apps/agent-worlds/` 在 `.git/info/exclude`（全 worktree 共享）——**线代码不入 git**；git 只承载 `docs/`（计划/报告）。收尾按 finishing-a-development-branch 把 `apps/agent-worlds/agent-codex/`（及 hub 测试小修）拷回主 checkout。
- **绝不触碰**：`~/.dsh`、`~/.superd`、主 checkout 的 `.superd-test/`（现役 4998 线的家）、live Caddyfile。`~/.codex` 只读（config/auth 拷入 worktree 测试 home，测试期拷入惯例 §七）。
- **Baseline（已验证 2026-09-15）**：worktree 内 agent-hub 15/15 绿，环境 = `DSH_HOME=<wt>/.superd-test/aw` + `AW_BARE_BASE=<wt>/.superd-test/aw/profiles/node_modules/`。任何测试/启动都带这两个 env。
- 缓存安装：`npm install --cache /home/u1/workspaces/superd/.npm-cache`（沙箱下 `~/.npm` EROFS）；exact-pin 无 `^`（devDeps 沿用 omp 现状）。install 后单实例检查：`find <wt>/node_modules/@deepseek-ai -maxdepth 1 -mindepth 1 ! -type l`（worktree 根 farm = 纯 symlink，应零输出）。
- 端口：本 worktree 线默认 **4987**（避开 3080/3081 prod、4998 主线现役、4999 ctx0 线）；拉起前 `ss -tln | grep :4987` 预检；仅 loopback。daemon 一律 `systemd-run --user`，关停 `systemctl --user stop`。
- 测试约定：`node --test test/*.test.mjs`；测试导入 `dist/`，先 build 后 test；每任务独立 commit（线代码 commit 落在 worktree 分支不可行时，以任务报告小节代替——git 只记 docs）。
- Codex 认证：测试 home 的 `agents/codex/` 拷入 `config.toml` + `auth.json` + `cc-switch-model-catalog.json`（本机 auth=apikey + cc-switch custom provider glm-5.2）。apikey 落 gitignored 区，不入任何 git 面。
- SDK 线能力边界（V1，源自 2026-09-10 缺口表）：无 steer（→ followUp 队列近似）、无 live setModel（→ 下一 turn 的 model option）、审批 = launch-only preset 映射（approvalPolicy + sandboxMode）、无 messages 手术/compact（fail-soft 缺省）、无 listThreads（→ rollout JSONL 扫描）。

---

### Task 0: 线内 hub 测试小修（已落在 worktree，收尾拷回）

**Files:**
- Modify: `apps/agent-worlds/agent-hub/test/zero-port.audit.test.mjs`（spawnWorld 调用补 `bareModuleBaseUrl: process.env.AW_BARE_BASE`——与 omp world-plugin 测试同模式；默认 anchor node_modules 无 `@pgmi-builds`）

**Interfaces:** 无产物变化，仅测试环境韧性。

- [x] Step 1: 修改 + worktree 15/15 验证（2026-09-15 已完成）
- [ ] Step 2: 收尾时随 agent-codex 一起拷回主 checkout

---

### Task 1: 包骨架 + SDK spike（P0 门）

**Files:**
- Create: `apps/agent-worlds/agent-codex/package.json`、`tsconfig.json`、`.gitignore`（node_modules/dist/lib）
- Create: `src/spike.ts` + `test/spike.test.mjs`（临时，Task 7 后删）
- Create: `scripts/setup-codex-home.mjs`（拷 `~/.codex` 三件到 `<DSH_HOME>/agents/codex/`，幂等）

**Interfaces:**
- Produces: `@pgmi-builds/agent-adapter-codex`（exports `.` → `dist/index.js`、`./world` → `dist/world-plugin.js`）；deps `@openai/codex-sdk@0.154.0`、`@openai/codex@0.154.0`（binary）、`@pgmi-builds/agent-hub: file:../agent-hub`；peerDeps @deepseek-ai optional（照抄 omp package.json 结构）。

- [x] **Step 1: 骨架**（package.json/ tsconfig 从 omp 拷贝改名；install 绿；单实例检查零输出）2026-09-15
- [x] **Step 2: codex home 拷入脚本**（+ prod-home 拒绝护栏，见发现 3）
- [x] **Step 3: spike 测试**（真 turn 6.1s PASS；0.154.0 API 与 Sept 10 研究一致，无偏差）
- [x] **Step 4: 事件序列样本**落 `test/fixtures/thread-events.sample.json`；abort 验证 195ms 断流
- [x] **Step 5: 发现记录于下**；docs commit（线代码不入 git，任务报告即追踪）

**Task 1 发现（2026-09-15 as-built）**：
1. 事件链实测：`thread.started{thread_id}` → `turn.started` → `item.completed{reasoning}` → `item.completed{agent_message "ok"}` → `turn.completed{usage}`。短 turn **无 item.started/item.updated**（长回答才可能流式）——投影必须三态全处理，`text_delta` 降级为可选通路。
2. 隔离实证：rollout/sqlite/logs 全落 `<wt-home>/agents/codex/`，`~/.codex` 零写入；rollout 路径 `sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` 与 Sept 10 研究一致。
3. **坑**：交互 shell 的环境 `DSH_HOME=/home/u1/.dsh`（prod）会漏进脚本缺省解析——setup 脚本已加 prod-home 拒绝护栏；一切命令显式 `DSH_HOME=<wt>/.superd-test/aw` 是铁律。
4. SDK `env` 为全量替换语义（须带 `...process.env`）；turn 级 `signal` 有效。

---

### Task 2: 事件投影 `src/codex-events.ts`

**Files:**
- Create: `src/codex-events.ts`
- Test: `test/codex-events.test.mjs`（输入 = Task 1 样本 fixture + 手造边界用例）

**Interfaces:**
- Consumes: codex `ThreadEvent`（运行时 duck-typed，不 import SDK 类型进 dist）
- Produces: `projectThreadEvent(evt: unknown): WireEvent | WireEvent[] | null`——投影到 **omp wire 词汇表**（`rpc-types.ts` 平移改名的内部词汇）：`agent_start` / `turn_start` / `message_start` / `message_update` / `message_end`（content blocks: text/thinking/toolCall）/ `tool_execution_start` / `tool_execution_end` / `turn_end` / `agent_end` / `text_delta`。未知事件 → `null`（ignorable，S5 路线不变量）。映射基准：`item.started(agent_message)` → message_start；agentMessage delta → text_delta/message_update；`command_execution` → tool_execution_*；`reasoning` → thinking block；`turn.completed|failed` → turn_end（failed 附 error）；run 结束 → agent_end。tokenUsage → `turn_end.data.usage`。

- [ ] Step 1: 失败测试（fixture 驱动：每类事件一条断言 + 未知事件 null + failed turn error 载荷）
- [x] Step 2: 跑红 → 实现 → 跑绿。映射表见子代理报告存档（本计划 Task 2 Interfaces + codex-events.ts 头注释为准）

---

### Task 3: `src/codex-client.ts`（CodexSdkClient 接缝）

**Files:**
- Create: `src/codex-client.ts`
- Test: `test/codex-client.test.mjs`

**Interfaces:**
- Produces: `CodexSdkClient`，公共面 = `OmpSdkClient`（`static spawn(args, cwd)` / `on` / `onFailure` / `sendRaw`(no-op trace) / `send`(命令分发) / `getState` / `getMessages` / `getSessionStats`(fail-soft {}) / `prompt` / `followUp` / `steer`(→followUp 近似，trace 标注) / `setModel(provider, modelId)`(暂存，下一 turn 生效) / `abort`(AbortController per run) / `newSession`(弃 thread 重开) / `close` / `ensureStarted`(resolve) / `spawned`(true)）。共享一个 `Codex` 实例（refcount 单例，同 omp sidecar 模式）；`CODEX_HOME` 经构造 env 注入；事件经 `projectThreadEvent` 后转发 listener。
- 会话身份：client 持 codex `thread.id` ↔ Dash sessionId 映射由 provider 层管（Task 7）。

- [x] Step 1: 失败测试——fake Codex 驱动，16 tests 含两条 review 回归（mirror-array、sessionEpoch）
- [x] Step 2: 跑红 → 实现 → 跑绿（16/16）
- [x] Step 3: live 测试文件就位、AW_CODEX_LIVE=1 门、skip 路径验证过；**未消耗 glm tokens**（fixture/fake 路径充分）
- [x] Step 4: 报告收到（2026-09-15）：27/27 + tsc 0 + 单实例检查 0；六项 deviation 全部与计划裁决一致

---

### Task 4: `src/codex-store.ts`（rollout JSONL 只读扫描）

**Files:**
- Create: `src/codex-store.ts`（拷自 `apps/multi-agent-ctx/agent-codex/src/codex-store.ts`，改造：去掉 app-server 主路（`callShared` import 与 server 分支），JSONL walk 升为唯一路；`CODEX_SESSIONS_ROOT` 从模块常量改为 `sessionsRoot(home)` 函数（`<home>/agents/codex/sessions`），env 仅作缺省）
- Test: `test/codex-store.test.mjs`（fixture rollout 文件：列表/HEAD 解析/derived id/memoized 重扫）

**Interfaces:**
- Produces: `listCodexSessions(home): CodexNativeSession[]`、`CODEX_SESSIONS_ROOT(home)`、`deriveDashId(threadId)`（omp-store 同款 derived-id 惯例）、`readRolloutTail(file, budget)`（resume 重灌用，Task 7）。

**Interfaces:**
- Produces: `listCodexSessions(sessionsRoot): Map<string, CodexNativeSession>`（key = codexThreadId；参数 = sessions 根）、`resolveCodexHome(home?)`（派生 `<home>/agents/codex`，env `CODEX_HOME` 次之，DSH_HOME 缺省）、`useCodexHome(path)`（显式终路径直用，prod 护栏）、`derivedDashId(threadId)`、`readCodexRollout(file): { slots, threadId }`（item 词汇 = SDK ThreadItem 形状 + `user_message` 扩展——SDK 无用户 item、rollout 有；Task 7 的 replay 在一处统一映射 omp 消息形）。

- [x] Step 1: fixture rollout（自造最小 JSONL，不拷用户隐私会话）+ 失败测试（2026-09-15）
- [x] Step 2: 拷贝改造 → 跑绿（6/6）。as-built 注记：`readRolloutTail` 并入 `readCodexRollout`（全量单遍读已足够；resume 重灌在 Task 7 消费 slots）；prod-home 护栏内置 `assertNotProdHome`；`session_meta.timestamp` 兼容 ISO 字符串与 epoch 数字。

---

### Task 5: `src/models.ts`（config.toml + model_catalog_json → 目录）

**Files:**
- Create: `src/models.ts`（拷自冻结线 `src/models.ts`，去 app-server `model/list` 路；解析 `<home>/agents/codex/config.toml`（`model_provider`/`model`/`model_catalog_json`）+ catalog JSON → `CodexModelCatalog`）
- Test: `test/models.test.mjs`（fixture config.toml + catalog）

**Interfaces:**
- Produces: `readCodexModelCatalog(codexHome?): { defaultModel, provider?, models: Array<{ id, label, reasoningEffort?, contextWindow? }> }`（fail-soft：文件缺失/解析失败 → 单条 `codex-default` 占位，never throw；参数 = codex home 终路径）。

- [x] Step 1+2: 失败测试 → 实现 → 跑绿（4/4）→ 真嵌套 home 实证：`{defaultModel:"glm-5.2", provider:"zhipu_glm_en", models:[{id:"glm-5.2", label:"GLM-5.2", reasoningEffort:"medium", contextWindow:1000000}]}`（2026-09-15）。as-built 注记：TOML 走最小行解析（仅顶层 key + `[model_providers.<id>].name`，非全语法）；catalog 只取 slug/display_name/default_reasoning_level/context_window 四字段。
---

### Task 6: world-plugin + world profile（S2 门，试金石）

**Files:**
- Create: `src/world-plugin.ts`（omp 同构：`registerAgent({key:'codex',label:'Codex',ready:false})` → `mkdirSync(<home>/agents/codex)` → `spawnWorld({appName:'aw-codex', profileName:'aw-codex-world', installAnchor: SUPERD_DSH_ANCHOR, home, bareModuleBaseUrl: AW_BARE_BASE})` → `registerForeignTarget({key:'codex', gateway})` → `setReady('codex', true)` → `ctx.provide('aw.world.codex', world)`）
- Create: `test/fixtures/aw-codex-world/{package.json,cordis.patch.yml,pnpm-workspace.yaml}`（bundle = dsh-base + dsh-web-app + `@pgmi-builds/agent-adapter-codex`；patch = webserver 127.0.0.1:0 + provider insert + 行表（Task 7 定稿后对齐））
- Test: `test/world-plugin.test.mjs`（omp 同款：provision 链接与 AW_BARE_BASE → apply → await world → roster/target/嵌套 home 断言 → dispose）

- [x] Step 1+2 文件已 staged（2026-09-15，本 main 线程）：world-plugin.ts + aw-codex-world fixture 三件 + world-plugin.test.mjs；src 全集 `tsc --noEmit` 0 错。**跑绿待 Tasks 2+3 落地后**（共享 dist/，避免构建互踩）。
- [x] Step 3: build + world-plugin 测试跑绿（2026-09-15 主线程统一验证 38/38：events 11 + client 16 + store 6 + models 4 + world-plugin 1——S2 门绿：roster/世界 RPC 面/gateway target/嵌套 home 全实证）
---

### Task 7: provider/agent/衔接层移植（最重，可再切子任务）

**Files:**
- Port: `src/index.ts`（OmpProvider→CodexProvider：createAgent/resume 事务照抄；threadId↔sessionId 转发表；rollout 路径入 OmpSessionIndex 对应物）
- Port: `src/agent.ts`（事件 switch 不变——词汇表已对齐；setModel/compact/subagents 走 SDK 缺口降级路径）
- Port: `src/replay.ts`、`src/session-persistence-codex.ts`（omp union 形态，OMP store 扫描换 rollout 扫描）、`src/agent-preset-codex.ts` + `agent-preset-projection.ts`、`src/permission.ts`（3-preset ↔ approvalPolicy/sandboxMode 映射表）、`src/knobs.ts`（裁剪版：仅 STORAGE_RECONCILE_INTERVAL_MS + cache 上限两项，避让/shadow/disk-tier 族全裁）
- **词汇表归属修订（2026-09-15）**：Task 2 的 `codex-events.ts` 已自带 Wire* 词汇（WireEvent/WireMessage/WireContentBlock/WireAssistantMessageEvent）——**不再单独移植 rpc-types.ts**，agent.ts 移植版直接从 `./codex-events.js` 导入（单一词汇源，两处定义必漂移）。
- **setupAndPublish 移植形（2026-09-15 通读定案）**：`new CodexAgent(loopCtx, id, agentOptions, session, client, idleExitCb)` → `setup?.(agent.ctx, agent)` → `commit?.commit()` → `sessions.enter+announce` / `agents.enter+announce` → `agent/session-start {source}` → dispose = agent.dispose + detaches（supervisor 段全裁）；owner-follow `ownerCtx.effect` 照抄；失败路径 unwind 半发布态 + `client.close()`；`preparation[Symbol.dispose]()` finally 照抄。`adoptSpawnedChild` 裁掉（client eager 创建，无 lazy 首染 Adoption 需求；threadId↔Dash id 映射在 provider 的 `CodexSessionIndex` 对应物内记）。
- **permission 3:3 映射（Task 7 定稿输入）**：`danger-full-access → sandbox: danger-full-access + approvalPolicy: never`；`workspace-write → sandbox: workspace-write + approvalPolicy: on-request`；`read-only → sandbox: read-only + approvalPolicy: never`（沙盒本身即约束，omp 的 always-ask 在 codex 无精确对应——**决策点**：若 UI 审批体验要求询问，改 `untrusted`，执行者实测后定）；env 覆盖 `CODEX_APPROVAL_MODE`（合法值 never/on-request/on-failure/untrusted，非法值忽略）。
- Modify: `cordis.patch.yml`（omp 版拷贝：insert codex-provider；disable agent-loop/llm-deepseek/llm-pi-ai/agent-presets/session-persistence-jsonl；permission 3-preset 表 defaultPreset 映射 codex sandboxMode）

- [x] Step 1: replay/knobs/preset/permission 逐文件移植 + 单测绿（2026-09-15 子代理落地：permission 4 + replay 7 + roster 7）
- [x] Step 2: codex-store 接入 persistence（scanByDashId/listCodexSessions → derived id → readCodexRollout → replayCodexSlots；SQLite/磁盘层裁掉）
- [x] Step 3: agent.ts（CodexAgent + convertContent/convertUsage/wireFailure）+ index.ts（CodexProvider 450 行）+ adapter.ts（CodexLlmAdapter）+ inbox.ts 移植，tsc 0
- [x] Step 4: cordis.patch.yml 行表落地（codex-provider insert + 5 行 disable + 3-preset 表 defaultPreset danger-full-access）→ world-plugin 测试携真 patch 复跑绿（provider/roster/persistence/projection/adapter 全挂载实证）
- [x] Step 5: provider 集成测试并入 Task 8 e2e（createAgent/resume 需全服务组合；world 测试已在真树挂载 provider——子代理裁决 #8，成立）
- [x] Step 6: 报告收到（2026-09-15）：60/60 绿 + tsc 0 + 单实例 0；九项 deviation 逐条核过（#2 codexApprovalMode passthrough、#4 approvalPolicy 随线程构造、#3 usage 一 turn 滞后等，源码复核成立）；docs commit
- **resume 语义（Task 7 执行输入，2026-09-15）**：omp 按 sessionFile `--resume` 换生为 codex 按 **threadId** `resumeThread(id)`——client 侧需新增 spawn 参数 `--resume-thread <codexThreadId>`（映射 `codex.resumeThread(id)`；与被拒的 omp `--resume <file>` 严格区分）。Dash 侧 seed events 仍从 `readCodexRollout` 重放（UI 历史），模型上下文由 codex 自己的 rollout 恢复。omp resume 的 foreignWriterPid/hot-mtime 避让段**裁掉**（无外来写者）。id 解析：`derivedDashId` ↔ `listCodexSessions` 扫描表（无 SQLite 索引）。
**Task 7 V1 裁剪（2026-09-15 通读 omp index.ts/agent.ts 后定案，执行者必读）**：omp provider 的下列子系统**不移植**——
- `supervisor`（避让/游标）：codex SDK 线子进程自管、嵌套 home 无外来写者（2026-09-10「不做避让」裁决 + S7 单向阀），无回避对象。
- 模型默认双向同步（`#syncModelDefaultTick`）：config.toml 对 adapter 只读（单向阀），模型选择走 turn 级 option。
- `installMobileBootScript` / `installOmpDiscovery`（skills/slash 注入）：OMP 专属面，SDK 线无对应。
- bridge SQLite store（`initBridgeStore`/reconcile）：列表权威 = rollout JSONL 扫描（codex-store），不再养第二索引；workspace reconcile 若保留则直接消费 `listCodexSessions`。
- fork 拒绝（`parentSession` throw）：照抄保留（codex 无原生 fork，语义一致）。
- `LazyOmpRpc` + `adoptSpawnedChild`（首 prompt 才物化子进程）：codex 侧 thread 由 CodexSdkClient eager 创建（startThread 零 IO），等价物 = client 本身；Lazy 包装**不需要**。
保留核心：createAgent/resume 事务（prepare→setup→publish）、union persistence、single preset roster + projection、llm adapter、approval 卡（extension_ui_request 在 SDK 线无来源——审批走 launch-only preset，`#handleExtensionUiRequest` 移植为死代码或裁掉，执行者定）。
---

### Task 8: 线集成（ctx0 + codex world，进程内 e2e）

**Files:**
- Create: `apps/agent-worlds/test/smoke-codex.mjs`（smoke.mjs 拷贝：REPO 解析改 `import.meta.url` 相对（worktree 可移植）；insert 行换 `@pgmi-builds/agent-adapter-codex/world`；等 `getTarget('codex')`）——**已 staged 2026-09-15**
- Create: `apps/agent-worlds/test/start-4987.sh`（start-4998.sh 拷贝：PORT=4987、LOG=.scratch/aw-codex-4987.log、superd 侧 bootstrap 前置 `node apps/agent-worlds/agent-codex/scripts/setup-codex-home.mjs`）——**已 staged 2026-09-15**
- **e2e 端点已钉死（2026-09-15 上游 fixture 核实）**：`session/list` / `session/create` / `session/prompt` / `session/page`（history: `{sessionId, throughSeq, beforeSeq?, maxMessages?}`）+ `$events` wire 流；payload 形状在活 world 上一次内省定稿。
- Create: `apps/agent-worlds/test/start-4987.sh`（start-4998.sh 拷贝：PORT=4987、LOG=.scratch/aw-codex-4987.log、superd 侧 bootstrap 前置 `node apps/agent-worlds/agent-codex/scripts/setup-codex-home.mjs`）
- Test: `apps/agent-worlds/agent-codex/test/e2e-world.test.mjs`：经 ctx0 selector 翻转 → world gateway `dispatchRpc('session/create'|'session/prompt'|$events)` 全链（进程内、零浏览器）

- [x] Step 1: e2e 失败测试（test/e2e-world.test.mjs：真 ctx0 boot + 假 codex factory——零 glm tokens；selector 翻转经 hub `[routing]` stderr 日志实证 `selector=codex -> CTX1`）
- [x] Step 2: smoke-codex.mjs + start-4987.sh 就位（2026-09-15 主线程 staged；smoke 增加 SUPERD_LAN_HOST trusted-host 支持）
- [x] Step 3: e2e 2/2 绿 + 全绿集 60/60 复跑（2026-09-15 调试子代理收尾）。**Task 8 过程中揪出并修掉两个生产级缺陷**：① npm 把 `file:` 依赖打包成物理副本——agent-codex/node_modules/@pgmi-builds/agent-hub 是第二 hub 模块实例，world plugin 的 routing target 注册进了副本而 ctx0 gateway 读 symlink 实例 → 拆掉该 dep，`@pgmi-builds` 链改落 worktree 根 node_modules（主仓根惯例）；② `#followThreadId` 真 JS 私有字段在 Cordis tracing proxy 接收器上 brand check 失败（omp registerHeld 同款教训）→ 改 TS-private 箭头字段。集成中实证的全链：create(agentPreset "codex") → selectModel(codex/glm-5.2) → prompt accepted → Dash log 全事件链（permission/sandbox/approval stamps、model/selection、agent-preset/selected、turn/start、user/message、session/title、**assistant/message×2**（thinking+text）、step/end、turn/end）。e2e 根因 = 测试假线程 `id` getter 缺 setter（首个事件即 strict-mode TypeError → onFailure → closeTurn(error)）——adapter 生产路径无恙（假线程修复 + 游标遍历读回后 completed-only 链 append 干净，step/start 非必需经实证）

---

### Task 9: 第一人称验收（repo 纪律）

- [ ] `ss` 预检 → `systemd-run --user --unit=aw-codex-4987-test`（env 三件套 + SUPERD_KEEP）→ token URL（loopback + 按需 socat LAN 中继，勿 0.0.0.0）→ **交 user 亲测，保持运行**。
- [ ] 验收点：roster 出现 Codex；切 codex 世界；新会话 prompt 走真 glm turn（cc-switch 目录）；abort；重启 resume；native 世界全程无感；`agents/codex/` 嵌套 home 自填充、`~/.codex` 零写入。
- [ ] 报告落 `docs/superpowers/plans/`（或 docs/test-reports 惯例）+ memory_flush + 收尾拷回清单（agent-codex/、hub 测试小修、本计划文档 merge 主 checkout）。

## 风险与已见坑（继承 + 本次实测）

- **SDK 0.154.0 vs 本机 CLI 0.153.4**：SDK exact-pin 自带 `@openai/codex@0.154.0` vendored binary，不依赖 PATH 的 0.153.4——spike 验证二者无 home 格式冲突（同 `~/.codex` 共存已由 GUI/CLI 双版本先例支持）。
- **沙箱 EROFS**：codex 必须可写 `CODEX_HOME`；测试 home 在 workspace 内（可写）。spike/集成若报只读文件系统，检查 CODEX_HOME 是否误指 `~/.codex`。
- **`~/.codex` 读取**：拷入脚本读 prod home 需真文件系统权限；沙箱拒绝时按仓惯例单次升级并说明。
- **词汇表漂移**：omp `agent.ts` 移植期间若发现消费了投影未覆盖的事件（extension_ui_request 等），按 fail-soft 降级并在报告记缺口，不扩 SDK 线范围。
- **hub 测试 17s+**：zero-port audit 拉真 world，慢是已知形态（主 checkout 同况），勿当回归。
