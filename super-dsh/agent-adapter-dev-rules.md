# Agent Adapter 开发规则（superd / agent-worlds 线）

> 状态：2026-09-15 user 裁定成文（对话记录于 `.scratch/aw-codex` AW-E 轮次）。
> 适用范围：所有 `@pgmi-builds/agent-adapter-*` 包（本线现役 `agent-codex`、`agent-omp`；曾用形态 `multi-agent-registry`（搁置）、`multi-agent-ctx`（冻结））。
> 用语：**adapter** = per-agent 适配包；**foreign runtime** = 上游原生 agent 运行时（codex / omp / …）；**DSH** = 上游 DeepSeek Harness；**superd** = dsh 之上的自研壳。

---

## 0. 定位（Position）

- 一个 **agent adapter 是 superd 壳下的一个自有包**，其**本身就是一个 dsh plugin**（带 `dsh.bundle.patch` 的 bundle patch 层 + 可选 `dsh.client` 呈现面）。
- superd 侧的路线史：`multi-agent-registry`（2026-09-10 搁置）→ `multi-agent-ctx`（冻结保留）→ **`agent-worlds`（现役）**。三条路线的**同一目标**：把 foreign agent runtime 引进 DSH native 面（会话/事件/模型/工作区都按 DSH 语义呈现）。
- **adapter 的核心职责**：把上游 foreign runtime **接线成一个完整、自洽的 dsh ctx**。接线完成度判据：**`dsh + 该 adapter` 自身就是一个 omp-web 式的可用 web app**（standalone 形态，见 §1-A）。
- agent-worlds 专属注入（`world-plugin` / `spawnWorld` / roster / hub 桥）只是**与 agent-worlds hub 对话的桥**，不是 adapter 的必要条件：adapter 不得把 hub、selector、spawn 机制当作自身存在前提。

## 1. 两种形态（两种都必须能跑）

| 形态 | 组成 | 用途 |
|---|---|---|
| **A. standalone app**（首选开发/测试形态） | `dsh(完整 composition: base + web-app + adapter bundle patch)`，单进程、自有 home、真实监听端口 | 开发、验收、单包测试；`dsh + adapter` ≈ omp-web |
| **B. world ctx**（agent-worlds 桥） | hub `spawnWorld()` 在 CTX0 进程内 `boot()` 出的 ctxN，adapter 挂在其中；roster/selector/委托由 hub 提供 | 多 runtime 并存、UI 内切换 |

- 差异**只允许**来自 patch 层注入（端口、home、注入行），**不允许**出现两份代码路径。
- 形态 B 的 client surface 也必须能在形态 A 正确交付（见 §4 客户端面交付层）。

## 2. 测试准则（Testing）

1. **每个 adapter 先按 standalone dsh web app 测**（真实例 + 真 runtime turn + 浏览器/curl 两者），直到该形态不再成立才引入形态 B。形态 B 的验收建立在形态 A 之上，不得反向。
2. 验收证据必须是**运行时行为**：
   - 真 runtime turn（**不得**以注入 fake factory 的 turn 作为验收证据；fake 仅限管道测试）；
   - HTTP wire（`POST /api/<ns>/<method>`，envelope `{type:"client-request",rpcId,method,payload}`）走一遍 create→prompt→readback；
   - 包自身测试套件在**该 app 的 home** 全绿（不是只在共享 home 绿）。
3. **专属 home**：adapter 单测/单跑时用自有 home（如 `AW_APP_HOME`），其 DSH 级状态（workspace 注册表、settings、session 日志）不与别条线共享；共享 home 里的残留（别线的 workspace、陈旧 settings）会污染结论。
4. adapter 自有 app 数据与 DSH 数据分账：见 §5。

## 3. 接线域（Wiring domains）—— 逐项，缺项必须显式记录为“未接/降级”

### 3.1 per-session
- **spawn / resume**（含 resume 的失败面：thread 不存在、rollout 损坏）
- **events**：foreign runtime 事件 → dsh 事件映射；至少覆盖
  - 系统提示、用户消息、助手消息（含 thinking/reasoning）、
  - 工具调用与结果（command/file change/mcp/web search…）、
  - **compaction**、**job list**、**subagent**、todo/plan 等结构化产物、
  - turn 生命周期（start/end、错误）
- **model list 与切换**（列目录来源必须真实；切换语义 = 立即 or 下一轮，需记录）
- **cwd / workspace**（会话 cwd = 用户工作区；见 §5 红线）
- **slash commands 与可呈现能力**：cmd、skills、mcp 等要透出给用户
- **面向用户的请求事件**：审批（approval）、选项/交互（extension UI 类）
- **session metadata**（标题、preset、权限档、创建/更新时间…）
- **runtime metadata**：token usage、LLM context 上限、耗时等

### 3.2 app-wide（非 per-session）
- **settings / config**：上游原生配置的读、写、以及「哪些可写」的单向阀判定
- **agent-preset 类设施**（≈ 普通意义上的 agent profile）：coding agent profile = skills / mcp / env / 默认模型等组合；DSH 侧以 preset（roster/projection）呈现

### 3.3 foreign runtime 就绪性与会话管理
- **readiness**：runtime 是否安装、版本、可交互面（**cli / rpc / http / sdk**）——**SDK 优先**，SDK 未覆盖处手工补齐（cli/rpc 不被排除，只是其“活会话连接”能力通常已被 SDK 覆盖；仅当要集成 `xxx plugin add …` 这类**命令级能力**时才重新引入）
- **session management**：idle session TTL、lazy spawn（构造零 IO，首 prompt 才物化）、transcript replay 后再 lazy resume 等策略

## 4. 每档均可 **per-adapter 决策**

- 上表每一项都允许按 adapter 给出不同裁决，并在该 adapter 文档里写明。
- 例如 `codex-desktop` 有 app-server 路径、能力集更大 → 足以另起一个 adapter（如 `agent-codex-gui`），与 SDK 线 adapter 的各项裁决可以完全不同。
- 决策必须落档（adapter README / 计划文档），不允许“隐式默认”。

### 4.1 客户端面交付层（实测结论，易错）
- `window.__DSH_BOOT__.entries`（浏览器 client surface 清单）由**服务 HTML 的那个 composition**静态产出：**surface 行必须挂在服务 HTML 的一侧**（standalone 形态下即 adapter 自己；形态 B 下世界是 loopback-ephemeral 口，世界侧 surface 行**到不了浏览器**）。
- client 产物必须**构建过**才会进清单（`dsh.client` 声明 + 产物文件存在）二者缺一不可。
- 需要「应用内」能力（如目录选择器）时，pin 具体 face（如 `browse` 的 host+client 两面）并 unmount stock `*-auto` 行；**不要 `disabled: true` 掉 stock 行本身**（那会连入口一起消失）。

## 5. Home 语义（红线；2026-09-17 user 裁定改版，取代嵌套 app-home 制）

三层分账：

- **foreign runtime 原生 app home**（`~/.omp` / `~/.codex` / `~/.claude` / `~/.pi`）＝ **app 数据的唯一 home**。adapter 经 SDK/RPC/CLI spawn runtime 时**绝不重定向**（不向 DSH 树喂 `OMP_HOME` / `CODEX_HOME` / `CLAUDE_CONFIG_DIR` / `PI_CODING_AGENT_DIR`）、**不做 config 单向阀拷贝**（旧 `ensureOmpAppHome` / `ensureCodexAppHome` / `seedClaudeHome` 已随本裁定退役）；runtime 自己读写自己的 home。测试隔离只经各 runtime 自己的 env knob 重定向，production 代码路径零重定向。
- **`<dshHome>/agents/<label>`** ＝ 该 agent 的 **world（ctx1/2/3）dsh web app 的 DSH home**：`sessions/`（DSH 侧会话日志副本）、`storages/`、`settings.yaml`、`profiles/web`，以及 adapter 自有 DSH 态（如 `dsh-sessions.json` 映射；omp 的 `bridge-store.sqlite` 照旧）。它**不再是 app home**。
- **绝不允许把 session cwd 指到任何 home**（有 adapter 这么干过，后患无穷）。**session cwd = 用户打开的 workspace**。
- **会话双份存储显式接受**：原生 home 存 runtime 原生会话（runtime 侧权威），`<dshHome>/agents/<label>/sessions/` 存 DSH 副本（WebUI 读取面）；单向阀 = 不回读原生会话做清单/回放。
- DSH 级状态（workspace 注册表、settings、session 日志）与 runtime 数据**分账**，各自有明确 owner。
## 6. 通用纪律（Discipline，违反即缺陷）

- 上游源码**零修改**；依赖 **exact-pin**；一切改动走 patch 层 / 自有插件。
- **单实例纪律**：`@deepseek-ai/*` 只能有一个模块实例（任何 install 后检查 `find <scope>/node_modules/@deepseek-ai -maxdepth 1 -mindepth 1 ! -type l`）。
- **禁真私有 `#` 方法**：Cordis tracing-proxy 会让 `#` 成员抛 `Receiver must be an instance of class X`——一律用 TS-`private`（含箭头字段）。
- **home 解析**：插件内从世界自身 `dshHomePath` 取，不读 `process.env` 兜底；DSH 侧状态（映射/store）锚 `<home>`（world DSH home 根）；catalog/rollout 读取走 runtime 的**原生 home**（`resolveCodexHome()` = `~/.codex` 等，env knob 仅测试），不要把 DSH home 传进期望 runtime home 的接口。
- **占位/降级值禁止外流**：fail-soft 的占位模型（如 `codex-default`）不得写进 settings、不得传给真实 runtime；降级必须显式 skip。
- **事件词汇**：映射到 DSH wire 词汇（`agent_start/turn_start/message_*/tool_execution_*/turn_end/agent_end`），保持与既有 adapter 一致，便于 agent.ts 平移。
- **fail-soft 与可观测**：readiness/目录/rollout 读取失败要降级且留痕（trace/logger），不得静默假成功。
- **测试 env 三件套**：`DSH_HOME=<专属 home>`、`SUPERD_DSH_ANCHOR=<install anchor package.json>`、必要时 `AW_BARE_BASE=<home>/profiles/node_modules/`。

## 7. agent-codex 现状（SDK-first 调查结论，2026-09-15）

**SDK 面（`@openai/codex-sdk@0.154.0` 类型声明全文）**：
```ts
class Codex  { constructor(options?); startThread(options?); resumeThread(id, options?) }
class Thread { get id(); runStreamed(input, turnOptions?); run(input, turnOptions?) }
ThreadOptions { model?, sandboxMode?, workingDirectory?, skipGitRepoCheck?,
                modelReasoningEffort?, networkAccessEnabled?, webSearchMode?,
                approvalPolicy?, additionalDirectories?, threadSource? }
events: thread.started / turn.started|completed|failed / item.started|updated|completed / error
```
**SDK 不提供任何 app-wide 设施**：无默认模型、无模型列表、无会话列表、无 workspace、无 fork/查询；唯一世界知识是 `resumeThread` 文档中的 “Threads are persisted in ~/.codex/sessions” ⇒ **rollout 扫描是会话清单唯一权威**。

| 接线域 | 供给方 | 实现要点 |
|---|---|---|
| spawn / resume | SDK | `startThread` / `resumeThread(id, opts)`；launch-only 的 approval/sandbox 经 ThreadOptions |
| events → dsh | SDK 事件 + adapter 投影 | `projectThreadEvent()` 水印去重 + 增量 |
| model list | **adapter** | 读 runtime home `config.toml` + `model_catalog_json` |
| 默认模型（app-wide） | **adapter** | 推 `agentDefaultModel.saveSelection()`（单向粘性；占位值禁推） |
| 会话清单 | **adapter** | rollout 扫描（`sessions/**/rollout-*.jsonl`） |
| workspace 归属 | 上游 `dsh-workspace` | adapter 只补：扫描结果 attach（上游仅首次 boot 自动分组） |
| slash cmd / skills / mcp | **adapter（补）** | 从 runtime home 的 skills/plugins 面读取并透出（**未接**） |
| 审批 / 交互请求 | 降级：launch-only preset | SDK 无运行时审批 ⇒ 映射到 3 档预设（`--approval-mode`） |
| token usage / ctx 上限 | SDK usage（滞后一轮）+ adapter 目录 | `contextWindow` 来自 catalog |
| compaction / subagent / job list | SDK item 词表 + adapter | 逐项核对投影（部分未接，需登记） |
| session mgmt | adapter | thread 由 runtime 持久化；Dash 侧 buffer-only + rollout 回放 |

**cli/rpc 的定位（codex）**：live session 连接已由 SDK 覆盖；仅在需要命令级集成（如 `codex plugin add …`）时才考虑补 cli/rpc 面。
**已知 V1 降级（登记在案）**：无 steer（仅排队 followUp）、模型切换下一轮生效、审批仅 launch-only、usage 滞后一轮、无 fork、无 supervisor（deliberate cut）。

---

## 8. 现行捕获策略：把 foreign agent **捕获进 DSH 服务**（2026-09-15 user 裁定；**falsifiable，随时间可变**）

> 标注为「现行」——这是一条**当前选定的开发取向**，不是永久不变量；当证据变化时可推翻并重述。

  - **原生 app 数据统一在原生 home**（2026-09-17 改版）：runtime 就跑在 `~/.codex` / `~/.omp` 等原生 home 上，不再有 adapter 侧 app-home 副本与 config 单向阀拷入；DSH 侧数据（会话日志、映射）独立存在于 `<dshHome>/agents/<runtime>`。
- **接受的代价（明知而为）**：
  - **会话存储重复**：一份在 DSH 侧（session log / 投影缓存），一份在 foreign runtime 侧（codex rollout、omp 原生 session）。两处都真实存在，**不是 bug**；DSH log 是 WebUI 的读取面，native log 是 runtime 的持久权威。
  - **新 spawn 的会话与原生 app 数据分离**：`.codex` / `.omp`（用户级原生 home）≠ `<dshHome>/agents/<runtime>`（adapter 的 app home）。二者是**不同集合**：原生 home 只读单向阀（配置拷入），adapter 的会话数据独立存在。
- **期望的迁移方向**：用户**逐步改用 DSH WebUI 作为交互面**，而不是继续依赖 foreign agent 的原生界面（TUI 等）。这正是简化开发复杂度的关键：adapter 只需把 runtime 接进 DSH 服务与事件词汇，**不需要**为此再造一套原生交互面。
- **推论（写给未来的自己）**：
  - 不要因为「原生已有」就省掉 DSH 侧的必要投影（会话列表、事件、usage 等）——用户看的是 DSH 面。
  - 反过来，也不要为了像素级复刻原生 TUI 而过度投入；DSH 面达标即可。
  - 若某天决定改走「桥接原生界面」的取向（如把原生 TUI 直接嵌进 DSH），本节整体作废，需重写规则。
- **开放项（本条策略下的已知缝）**：foreign threadId ↔ DSH sessionId 的映射目前是**进程内**的（`threadIdIndex`），跨重启后同一 thread 会以 rollout 派生的 `session-codex-<threadId>` 形式重新出现，与重启前的 Dash id（普通 uuid）不同 ⇒ 同一 thread 在重启边界上可能出现两个 id。收敛方向（择一）：把 Dash session id 在创建时就锚定到 threadId，或把映射持久化。

## 9. codex 能力面 survey 与接线 backlog（2026-09-15，实证）

**证据来源**：真实 rollout JSONL（`<home>/agents/codex/sessions/**`）+ vendored CLI `--help` + `codex app-server generate-ts --out …`（**95 个协议类型**，含全部 method/notification 名）。

### 9.1 SDK 现状 vs 原生事件词汇（rollout 实测）
| rollout 行类型 / payload | 实测字段 | DSH 侧可落点 | 现状 |
|---|---|---|---|
| `session_meta` | **`base_instructions`（= 系统提示原文）**、`context_window`、`cli_version`、`git`、`cwd`、`history_mode`、`source`、`thread_source` | 系统提示/会话元数据/上下文上限 | **未接** |
| `turn_context` | `model`、`effort`、`sandbox_policy`、`file_system_sandbox_policy`、`approval_policy`、`permission_profile`、`workspace_roots`、`collaboration_mode`、`personality`、`multi_agent_version`、`summary`、`timezone` | **有效的**运行时元数据（模型/推理档/沙箱/审批/工作区根） | **未接** |
| `event_msg: token_count` | `info`（含用量）+ **`rate_limits`** | 实时 token 用量、配额面 | 部分（SDK usage 滞后一轮） |
| `event_msg: task_started` | `model_context_window`、`collaboration_mode_kind` | ctx 上限、协作模式 | **未接** |
| `event_msg: task_complete` | `duration_ms`、`time_to_first_token_ms`、`last_agent_message` | 轮次耗时 / TTFT / 最后一条助手消息 | **未接** |
| `event_msg: thread_settings_applied` | `thread_settings` | 会话设置生效确认 | **未接** |
| `item_completed.item` | `AgentMessage` / `UserMessage` / `Reasoning` / `McpToolCall`(server,tool,status,duration,result) | 消息/思考/工具调用 | 已接（部分） |
| `turn/…`（SDK） | thread.started / turn.started\|completed\|failed / item.* / error | 轮次生命周期 | 已接 |
| `token_usage_record` | `thread_token_usage`、`turn_token_usage`、`usage` | 线程/轮次用量 | **未接** |
| `world_state` | `full`、`state` | runtime 内部世界态（skills/plugins/goals 线索） | **未接** |

### 9.2 app-server 协议面（SDK 之外的完整能力，`generate-ts` 实证）
- **thread 生命周期**：`thread/start`、`thread/resume`、`thread/list`、`thread/read`、`thread/turns/list`、`thread/items/list`、`thread/loaded/list`、`thread/fork`、`thread/name/set|updated`、`thread/metadata/update`、`thread/archive|unarchive|delete`、`thread/status/changed`、`thread/settings/updated`、`thread/shellCommand`、`thread/fork`、`thread/revert`、`thread/rollback`、`thread/inject_items`、`thread_unarchive`、`threadSection/{create,update,delete,list}` + `thread/section/move`（**会话分区/文件夹**）
- **轮次控制**：`turn/start`、**`turn/steer`（SDK 没有的 steer！）**、`turn/interrupt`、`turn/diff/updated`、`turn/plan/updated`、`turn/completed`、`turn/moderationMetadata`
- **压缩**：`thread/compact/start`、`thread/compacted`、`context_compaction`、`compaction_trigger`、`AutoCompactTokenLimitScope` ⇒ **DSH 压缩事件可接**
- **审批 / 交互（SDK 完全缺失）**：`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`、`item/tool/requestUserInput`、`ApplyPatchApproval`、`item/autoApprovalReview/*`、`thread/approveGuardianDeniedAction`、`mcpServer/elicitation/request` ⇒ **审批与选项事件可接**
- **流式增量**：`item/agentMessage/delta`、`item/reasoning/textDelta|summaryTextDelta|summaryPartAdded`、`item/commandExecution/outputDelta|terminalInteraction`、`item/fileChange/outputDelta|patchUpdated`、`item/mcpToolCall/progress`、`item/plan/delta`
- **模型 / 权限档**：`model/list`、`model/rerouted`、`modelProvider/*`、`permissionProfile/list`
- **技能 / 插件 / 钩子**：`skills/list`、`skills/changed`、`skills/config/write`、`skills/extraRoots/set`；`plugin/{list,read,install,installed}`；`hooks/list`、`hook/started|completed`
- **MCP**：`mcpServerStatus/list`、`mcpServer/oauth/login`、`mcpServer/resource/read`、`mcpServer/tool/call`、`mcpServer/event/stream/notification`、`mcpServer/startupStatus/updated`
- **用量 / 配额 / 账号**：`thread/tokenUsage/updated`、`account/usage/read`、`account/rateLimits/read|updated`、`usageLimitExceeded`、`account/{read,login/*,logout}`、`account/rateLimitResetCredit/consume`
- **文件系统 / 工作区 / git**：`fs/{readFile,writeFile,readDirectory,createDirectory,remove,copy,getMetadata,watch,unwatch}`、`fs/changed`、`gitDiffToRemote`
- **其它**：`thread_spawn`（子代理/线程派生）、`review/start`、`thread/environment/connected|disconnected`、`thread/project/updated`、`thread/realtime/*`（实时音频/转写）

### 9.3 CLI 子命令面（vendored 二进制 `--help` 实证）
`agents`（浏览共享 local app-server 守护进程上的所有会话）、`exec`、`review`、`login/logout`、`mcp {list,get,add,remove,login}`、`plugin`、`app-server {daemon,proxy,generate-ts,generate-json-schema}`、`remote-control`、`doctor`（安装/配置/认证/运行时健康）、`sandbox`、`debug`、`apply`、`resume`、`queue`（给已有会话排队消息）、`archive`、`delete`、`migrate-rollouts`、`completion`、`update`。

### 9.4 接线 backlog（建议优先级）
1. **P1 运行时元数据**：`session_meta.base_instructions`（系统提示）、`context_window`、`turn_context` 的有效 model/effort/sandbox/approval/workspace_roots → DSH session/runtime metadata（现状全缺，UI 只能靠猜）。
2. **P1 用量**：`token_count` + `token_usage_record`（含 `rate_limits`）→ DSH usage 事件（当前滞后一轮）。
3. **P1 轮次指标**：`task_complete` 的 `duration_ms`/`time_to_first_token_ms`。
4. **P2 压缩**：`context_compaction` / `thread/compacted` → DSH compaction 事件（长会话必需）。
5. **P2 会话清单与生命周期**：改用/对照 app-server `thread/list` + `agents`，并接 `archive/delete/name/metadata`；收敛 §8 的 id 映射缝。
6. **P2 skills / mcp / plugin 面**：`skills/list`、`mcpServerStatus/list`、`plugin/list` → 面向用户的 slash/能力面板（SDK 无）。
7. **P3 审批与交互**：`*/requestApproval`、`requestUserInput`、`mcpServer/elicitation` → DSH 审批/扩展 UI（当前 launch-only 降级）。
8. **P3 流式增量与 steer**：`*/delta`、`turn/steer`（SDK 不支持）→ 实时体验与打断插话。
9. **P4 其它**：`fs/*`、`gitDiffToRemote`、`review/start`、`thread/fork`、`threadSection/*`、`thread_spawn`（子代理）。
10. **形态判断**：以上 5–9 大量能力**不在 SDK**，属 app-server 面 ⇒ 按 §4 的 per-adapter 决策，**`agent-codex-gui`（app-server 线）** 是这些能力的自然归属；SDK 线（本包）保持 happy path + P1/P2 里可由 rollout/CLI 补的项。

---

## 10. DSH-native session 管理的机制事实（2026-09-15 实证，指导 agent-codex 重构）

**上游机制**（`packages/core/agent-loop/src/index.ts`、`packages/session/session-persistence-jsonl/src/storage.ts`）：
- 工厂必须**自己持有会话的持久化写通道**：create 用 `ctx.sessionPersistence.create(session.header, {inheritedEventCount})`，resume 用 `open(id,'write')` + `handle.read()`；jsonl 后端通过 `ctx.on('session/event', …)` 把已提交事件写入该 handle 的 writer，`handle.close()` 排空。
- 上游原话：**在 agent 生命周期之外发布的 session 不持久化任何东西**（`core/session/src/index.ts:885-891`）。
- resume 的标准动作：`handle.read(0,undefined,{signal})` → `interruptedTurnClosers(events)` 追加修补 → `sessions.prepare(id, { seed:[...events,...closers], meta: structuredClone(handle.header), inheritedEventCount, eventState })`。
- jsonl 落盘：`<home>/sessions/--<normalized-cwd>--/<encoded-id>/session.v<N>.jsonl[.zstd]`（默认 zstd；首行是 header，其后每行一个持久事件）。

**OMP 线现状（对照，反面教材的一半）**：它自带 `SessionPersistence` 子类 + 自己的 SQLite 索引（`bridge-store.sqlite`：omp id ↔ dsh id ↔ transcript 文件），`list` 走索引、`open('read')` 由 OMP transcript 重新派生 DSH 事件，**DSH 侧日志只在内存**（无 `session/event` 监听）——即「DSH 服务只做呈现层，数据权威仍在原生 transcript」。这带来大量维护：id 索引表、增量摄入、派生 replay 缓存、影子 session、viewer 触发等。
- adapter 只保留**一张极小的映射**（`<worldHome>/dsh-sessions.json`，world DSH home 根；2026-09-17 起不再嵌在 app home 里）：`dshSessionId → { threadId, cwd, createdAt, preset }`。因为 Codex 的 threadId 仅在该线程首个 turn 后才成立，而 resume 需要它——这是「只做 mapping」的全部内容。
**本线（agent-codex）改为 DSH-native（2026-09-15 user 裁定）**：
- 启用上游 `session-persistence-jsonl`（不再 disable），工厂持写通道 ⇒ **list / replay / 冷读全部由 DSH 服务提供**，adapter 不再扫描、不再解析原生 JSONL 做会话列表或 replay。
- adapter 只保留**一张极小的映射**（`<codexHome>/dsh-sessions.json`）：`dshSessionId → { threadId, cwd, createdAt, preset }`。因为 Codex 的 threadId 仅在该线程首个 turn 后才成立，而 resume 需要它——这是「只做 mapping」的全部内容。
- 原生 rollout 仍由 Codex 自己写（runtime 侧权威，S3/S7 单向阀），但 adapter 对它的唯一读取是**system prompt 的头部元数据**（`session_meta.base_instructions`），不是 transcript replay。
- **待验（本轮验收）**：真 turn 后 DSH 日志落盘 → 重启 → list/replay 由 DSH 提供 → resume 经映射重挂 codex 线程。

## 11. DSH 会话事件词汇（上游实证，接线对照表）

- 事件总数 55（`packages/core/session/src/known-event-types.ts`）；信封 `{type, seq, time, data, ignorable?}`，仅 4 个 surface 事件带 `surfaceOp`/`sourceEventSeqs`：`system/message`、`user/message`、`assistant/message`、`tool/result`。
- **system prompt** = `system/message {turn, step, message}`，`message = createSystemMessage(text, plugin)`（空文本 ⇒ `content: []`）；上游 loop 每会话恒写一条（surface 节点 0），**不是** header 字段。
- **reasoning/thinking** = `assistant/message.message.content` 里的 `{type:'reasoning', text}`（**不是 `thinking`**）；原始增量另存于 `assistant/message.stream` / `assistant/attempt.stream`。
- **tool call/result** = `tool/call {turn,step,callId,name,arguments: string(原始 JSON 串)}` + `tool/result {turn,step,message: ToolResultMessage, error?, meta?}`（`createToolResultMessage({callId,content,isError})`，按 `callId` 配对）。
- **system 类（log-only，非 surface）**：`approval/asked|decided|policy`、`permission/preset`、`sandbox/mode`、`plan/mode`、`model/selection`、`agent-preset/selected`、`session/title`、`request/header|context`、`compaction/*`、`todo/write`、`goal/change`、`subagent/*`…（无 `system/notice`/`system/error`；错误经 `turn/end{reason:{kind:'error'}}`）。
- **context injection**：**没有** `context/*` 事件；注入 = `user/message` 且 `source.kind==='plugin'`（`ContextFormed.form`: `instructions|catalog|snapshot|notice|relay|recall`）；文件/图片是 content block（`file`/`image` + attachment ref），不是事件。
- 关系不变量（`invariant.ts`）：turn 从 1 起、step 每 turn 从 1 起；step-scoped 事件（system/assistant/tool call|result/attempt）必须落在**已开**的 turn+step 内；`user/message` 不受限；`turn/end` 必须闭合当前 turn。

---

## 12. Per-agent 定制权（2026-09-16 user 裁定）

- **DSH 侧的一切都是 per-agent 可定制的**：原生 WebUI（shell / 面板 / 插槽呈现）、ctx1（世界）内的一切 dsh 组成、以及 adapter 自己的行表与客户端面——**每一层都由 adapter 自行决定**：可以 patch、可以自己开发替代物、也可以只挂最小面。
- 推论：
  - **不得**把「原生 UI 就是这样」当作不可动的前提；adapter 的 UX 目标在其自身层级解决（够用即可，不追求像素级复刻原生）。
  - 反过来，**也不得**把某个 adapter 的定制上提为线/hub 级规则；hub 只提供机制（挂载、路由、roster），具体面由 adapter 决定。
  - 「native 面被 patch/替换」属正常手段（例：pin `browse` 目录选择器、替换 `*-auto` 行、换掉 world 的 webserver 姿态）；但**上游源码零修改**仍是红线——定制一律走 patch 层或自有插件/包。
  - 定制决策必须落档在该 adapter 的文档里（发现即记录），便于将来另一个 adapter 做相反选择。

## 13. Home 与 profile 布局（2026-09-17 user 裁定改版，取代 2026-09-16 版）

- **`$DSH_HOME` = 测试 home**（仓内约定：`<repo>/.tests`；绝不触碰 `~/.dsh` / `~/.superd`）。
- **agent world DSH home = `$DSH_HOME/agents/<label>`**（例：codex → `<repo>/.tests/agents/codex`）——该 agent 的 dsh web app（world）自有 DSH home：`sessions/`、`storages/`、`settings.yaml`、`profiles/web`，外加 adapter 自有 DSH 态（`dsh-sessions.json`）。**不再是 native app 的 app home**（旧「agent app home = `$DSH_HOME/agents/<label>`」裁定废止）。
- **foreign runtime app home = 原生 home**（`~/.omp` / `~/.codex` / `~/.claude` / `~/.pi`）——spawn 零重定向、零 config 拷贝；测试隔离只走 runtime 自己的 env knob（`OMP_HOME` / `CODEX_HOME` / `CLAUDE_CONFIG_DIR` / `PI_CODING_AGENT_DIR`）。
- **agent dsh profile packages = `$DSH_HOME/profiles/<label>`**（例：`<repo>/.tests/profiles/codex`）——该 agent 的 dsh profile（`package.json` 的 `dsh.profile.bundles`、`cordis.patch.yml`、`pnpm-workspace.yaml`）。
- **禁止自造 per-app home**（`.tests/codex-app`、`<world>/.codex` 嵌套等均属违规先例）；`profiles/node_modules/@pgmi-builds/*` 仍集中在 `$DSH_HOME/profiles/node_modules/`。
- `<label>` 取 agent 的 roster key / 运行时短名（codex、omp、claude、pi、…）。

## 14. 会话物化纪律：两类数据面（2026-09-18 user 裁定）

CLI/TUI 形态的 foreign app（codex/claude 有 GUI app，但尚无 agent-*-gui adapter）向 DSH 呈现两类数据，纪律不同：

- **i) per-session 数据 = live session stream** → **永远 lazy spawn**：查看/创建/resume 一个会话**不产生任何 native 进程**；子进程只在首个真实 prompt 时物化，到 agent 自身生命周期（idle-exit / dispose）为止。DSH 侧的 transcript 回放/列表/检索由 dsh session 服务从 DSH 日志（`agents/<label>/sessions/`）完成，**与 native 进程无关**。
  - 本条 **falsifiable**：GUI app adapter、native 侧 session 管理、RAM/效率考量等可以推翻（记录于该 adapter 文档）。
  - 血统：omp-web `LazyOmpRpc` 的 lazy creation 铁律（`~/workspaces/dsh-omp/apps/omp-web/AGENTS.md` §一：两条路径都必须 lazy，resume 无映射分支曾误用 eager spawn——已知复发点）。现行落地：omp（铁律）、hermes（2026-09-18 起 `spawn({lazy:true})`，pre-ready 失败在 client 内部换子进程重试，≤`HERMES_SPAWN_ATTEMPTS`(3) 次，ready gate 跨重试不换对象；handshake `session.create/resume` 瞬态失败同 client 重试 ≤3 次，RPC 拒绝=永久不重试；**turn prompt 永不自动重试**）、pi/codex（in-process SDK / 无子进程）。
- **ii) app-wide 数据 = config、model list、磁盘状态** → **manual opt-in 读/同步**：一个手工脚本即可；**绝不为此 spawn 会话**。i) 期间观测到的 app-wide 数据变更可以回流 ii)。
  - 现行落地：claude boot probe（一次 ephemeral SDK 查询问 CLI 自己的 `supportedModels()`——`~/.claude` 无 catalog 文件，alias 集编译在 CLI 二进制内，cfg-read 不可能）、hermes `model.options` 探针（用后即弃、自有关闭）。
- **映射与复活**：dsh↔native 会话身份 = `dsh-sessions.json` 映射，**mapping only**；映射缺失 → 带稳定错误码 fail-closed。**绝不为恢复配对去解析 native 会话存储**（2026-09-18 裁决：codex 曾加 `~/.codex` rollout discovery，违背本条，已删；native home 只贡献 cfg/settings + 经映射的 live-context resume）。claude 特例：派生 id 的 conversation 未物化（如首回合失败）→ `CONVERSATION_NOT_FOUND` + map 记 `resumable:false`，后续 prompt 快速失败——**忽略该会话，绝不把既有内容包装成 user message 复活**。
- **事件流诚实原则（2026-09-18）**：adapter 只负责把 native 流**诚实/尽力**投影成 dsh 类型化事件（tool call 是 tool call，agent msg 是 agent msg）；折不折叠、算不算 usage、同 turn 还是新 turn 是 **dsh WebUI 自己的逻辑**，不为迁就 UI 折叠器扭曲投影。工具名归一化到 dsh 词汇表（claude：Bash→bash、Write→write、Read→read、Edit→edit、Grep→grep、Glob→glob；未知名 verbatim 透传，不造名）。

## 15. Hub client-shim 拦截面清单（world 页面注入；ctx0 页面零注入）

`agent-hub/src/client-shim.ts`（`renderClientShim(labelPath)`，world index 的第一个 head script）共 **6 个拦截面**，全部窄域、幂等（`__DSH_*` 哨兵防重入）：

| # | 面 | 规则 |
|---|---|---|
| 1 | `__DSH_TRANSPORT__.fetch` | Connection RPC fetch（URL 对象入参）→ 重挂载 |
| 2 | `WebSocket` / `EventSource` / `XMLHttpRequest` 构造器 | 同源根绝对路径 → 重挂载（Proxy 保静态/原型/instanceof） |
| 3 | `__DSH_FILE_UPLOAD__` | 上传绕过 blob worker，页内 fetch 带重挂载 |
| 4 | `Storage.prototype` get/set/remove | per-world key 命名空间（`<label>:` 前缀；NS 从 PREFIX 派生——LABEL 字面量会被 index-pass 双写） |
| 5 | `globalThis.fetch`（2026-09-17 H1） | **仅根绝对 `/api` 路径**重挂载；query/hash 保留；相对/同挂载/跨源不动 |
| 6 | `HTMLAnchorElement.prototype.click`（2026-09-18 H1 r2） | **仅带 `download` 属性且 href 为同源根绝对 `/api` 的锚点**；其余（含 selector 的 `/<label>/` 锚点）一律不动 |

r1 教训（live-found 2026-09-18）：upstream `downloadUrl()` 对**脱离 DOM** 的 `<a download>` 调 `.click()`——document 级 capture listener 收不到（事件不经 document），而**无差别**重写 listener 会把 selector 锚点改写成 `/<当前label>/<目标label>/` 直接弄坏跨世界导航。两个坑决定了 #6 的形态：方法级拦截 + download+/api 双条件。`/api` 字面量保持**单引号**（index-pass 只双写双引号字符串，回归测试钉死）。

## 17. 闭源 vendor 的 landing/onboarding 转接（2026-09-18 user 裁定；适用 Gemini / Anthropic / OpenAI 三家，falsifiable per-vendor）

- **触发条件**：adapter 启动/建会话时，扫描本机对应登录态位置**无已登录证据**（各 runtime 的证据位置登记在该 adapter 文档：agy = `~/.gemini/antigravity-cli/antigravity-oauth-token`；claude/codex 类推）。
- **流程（桥接为临时 DSH 会话）**：adapter 在 Web UI 创建一个临时 DSH conversation session → 发起 runtime 原生 onboarding → 结构化交互转译为 DSH 消息：认证方式选项 → 文本 message；**认证 URL → 直接作为 message**（WebUI 可点击，体验优于 SSH/TUI 终端里的纯文本 URL）→ 用户浏览器完成认证，把凭据串 **paste 回 chat** → adapter 喂回 runtime stdin/SDK。
- **成功**：用户在**同一会话**发出的下一个真实 prompt 才发起真 native session（lazy spawn 纪律不变）；onboarding 交互**不计入** turn 内容（与 TUI 体验一致：onboarding 不是对话轮）。
- **失败**：向该 DSH session 注入一条 **context injection**（`user/message` 且 `source.kind='plugin'`）：「认证失败，请发起新 session 进行认证」——明确告知**不要在同一 session 重试**；该 session 作废（永不与 native 配对，对齐 §14 mapping-only：不复活、不伪造）。闭环：无效 session 显式废弃 + 明确提示。
- **落点 per-vendor（勿假设 SDK 有 onboarding）**：SDK 是库，通常 fail-loud 无交互（**实测反例：google-antigravity@0.1.17 无凭据时 `ValueError: A Gemini API key is required`，无任何 onboarding 弹出**）；结构化 onboarding 通常在 **CLI 的 stdin/stdout**（实测：`agy` headless 打印认证 URL + "paste the authorization code here" 读 stdin——机器可读，正是桥接面）。各家 adapter 落地前必须先实证自己的 onboarding 通道形态（CLI 结构化流 / SDK 错误码→选项映射），并登记。

## 16a. agent-agy 消费者优先路线修正（2026-09-18 user 裁定，压过 §16 的 ADC 结论）

- **产品前提**：本 App 面向个人消费者——**不能假设用户有 ADC/GCP**；认证入口 = **Gemini API key**（获取成本最低），ADC 降为可选加分（SDK 有则自动用，adapter 不主动要求）。
- **选型前提（硬门）**：headless CLI / SDK 候选**必须支持 Gemini API key 消费**才予采用。实测（2026-09-18）：**SDK ✅**（`GEMINI_API_KEY` env 自动读取、零 vertex 参数、真打 Google 鉴权通过；本 key 429 = 余额耗尽，非认证/geofencing）；**CLI headless ❌**（1.2.6 print 族喂 `GEMINI_API_KEY` + `modelProvider:"gemini"` 仍强制 Antigravity OAuth，临时 HOME 复现）。⇒ **SDK 路线唯一胜出**；§16 的"CLI 双面兼任"与"ADC 单平面"结论相应作废。model list/默认模型 = 磁盘读（`~/.gemini/antigravity-cli/settings.json`）+ catalog 静态捕获，零认证。
- **SDK 地理可达性**：本机网络直达 Google 无 geofencing；dev3 proxy 仅留作后备（未启用）。
- **CLI OAuth 路线穷尽判定（2026-09-18 夜，user 亲测）**：headless 的 URL→paste OAuth 流**机制上可桥接**（pty + stdin 实证全链路），但服务端资格检查拒绝：`Eligibility check failed: not available in your location`。**proxy 穷尽（2026-09-18 深夜）**：agy 认 `HTTPS_PROXY`（http/https/socks5h 均生效，bogus-proxy `proxyconnect` 报错实证）；经 **dev4 美国出口（Oracle US SOCKS5）** 依然拒 ⇒ **资格是 Google 账号级地区判定，换 IP 无解**（token 跨机亦无用，账号绑定）。分流结论：**账号地区合格的用户（美/日/新/加本地账号）CLI OAuth 可通**——开源后按账号 eligibility 自动分流（CLI OAuth 可用则用，不可用落 SDK+API key）；本机 HK 账号属后者，SDK 路线即本机唯一 live 面。桥接实测规格：agy 等待窗口硬编码 60s；URL 打印与 stdin 类型相关（/dev/null 或 pty 打印，FIFO 快速退出）——桥接必须走 pty（`script` 族）。
- **BYO-endpoint 实测打通（2026-09-18 深夜 spike）**：SDK `GeminiAPIEndpoint` 原生 `base_url` 字段 + localharness 认 `GOOGLE_GEMINI_BASE_URL`（**值不带 `/v1beta`，SDK 自动追加**；Gemini SSE 无 `[DONE]` 终止符——OpenAI 惯例的 `data: [DONE]` 会让 localharness 解析器报错）。spike `agent-agy/bridge/gemini_openai_server.mjs`（Gemini generateContent/streamGenerateContent:alt=sse 前端 → OpenAI chat/completions 后端）+ **DeepSeek 后端真 turn "BYO-OK" 1.4s 全通** ⇒ **agy 大脑可换任意 OpenAI 兼容端点（DeepSeek/千问/GLM/Kimi…）**。V1 gap：tools/multimodal 未翻译——agent 工具链（Gemini function-calling ↔ OpenAI tool_calls）往返保真是产品化前必须补验的主风险。开源现成工具该方向缺位（现有全部是 OpenAI→Gemini 反方向；官方 `v1beta/openai/` 兼容端点亦反方向）。**随后实测 LiteLLM Proxy 原生 Gemini 协议入口（`/v1beta/models/{model}:generateContent|streamGenerateContent`，model_group_alias 路由任意 provider，含 function-calling 翻译/fallback/虚拟 key）——同一探针 DeepSeek 后端 "BYO-OK" 2.9s 全通（litellm 1.101.0）** ⇒ **不自研，选 LiteLLM**（翻译保真由上游维护；自研 130 行缺 tools/multimodal）。已知 quirk：原生 generateContent 请求体个别字段形状差异（BerriAI/litellm#12671，generationConfig→config 映射已修）。产品化前仍需拿非 Gemini 后端验 agent 工具链真 turn。开源现成工具其余皆反方向（OpenAI→Gemini；官方 `v1beta/openai/` 兼容端点亦反方向）。定位：per-adapter 开放项，不阻塞 SDK 主线。

## 16. agent-agy（Google Antigravity CLI）接口选型裁决（2026-09-18，调研落档；live 面结论被 §16a 修正压过，本节存档 falsify 过程）

> 计划正本：`docs/superpowers/plans/2026-09-18-agent-agy-adapter-plan.md`。本节是 §3.3「SDK 优先」的一次**显式 per-adapter falsify**（§4 授权范围内），非规则改版。

- **本机事实**：`agy 1.2.6`（Go 二进制，`~/.local/bin/agy`）；native home `~/.gemini/`（conversations = `antigravity-cli/conversations/*.db`，SQLite+protobuf）。认证走 native home（keyring/OAuth token）。
- **ACP：falsified** —— `agy` 无原生 ACP 面（官方 issue google-antigravity/antigravity-cli#31 开放中）；社区 `agy-acp` 桥全部依赖解析 native conversations DB，违反 §14「绝不解析 native 会话存储」，不采。
- **A2A：falsified**（仅托管云侧有，CLI/SDK 无 server 面）。
- **Python SDK `google-antigravity`：falsified as primary** —— 仅 API key/Vertex 认证、无 OAuth 路径（native home 登录态用不上）且为 Python 线（本线 TS/node）；登记为 API-key 用户的旁路开放项。
- **选定（2026-09-18 二轮反转）：Python SDK `google-antigravity@0.1.17` live 直连**（方案一实测通过）——`LocalAgentConfig(vertex=True, project, location)` + ADC service-account env，真 turn 成功（模型回 "OK"），**完全绕开 Antigravity OAuth**。实测指标：import 0.42s、session spawn 0.49s（内嵌 `localharness` Go 二进制 132MB 落盘、组合 RSS ~160MB）、turn ~3.9s（服务端延迟）。**§3.3 SDK 优先恢复成立**——此前 falsify 是在 CLI 头上碰壁后误推的；CLI 转为 app-wide 探针面（`agy models` 纯接口 578ms 即退、不启 TUI 会话；默认模型可直接读 `~/.gemini/antigravity-cli/settings.json` 的 `model` 字段——user data 里有，不 spawn 任何东西）。SDK runtime **同样读本机 user data**（localharness 内嵌读 `~/.gemini/antigravity-cli/settings.json`、artifacts 写 `~/.gemini/antigravity/`）；`save_dir` 缺省 mkdtemp（可显式指 world home，adapter 自有数据）。model 目录发现 SDK 无 list API（models.py 只有 endpoint/target 类型），catalog 仍走 CLI manual 一次性捕获。
- **auth 双轨事实（2026-09-18 定案）**：user TUI 登录 = token 文件 `auth_method: "gcp"`（Vertex 味），**仅 TUI 交互路径消费**（language server 显式传 AuthMode）；agy 1.2.6 headless print 族（含 stream-json）只认 Antigravity 账号 OAuth token source，对 gcp 味报 "not logged into Antigravity"（log 实证）→ **CLI live 面被 auth falsify，SDK ADC 面 works**。CLI spawn 探针（`agy models`）也受此阻塞——catalog 捕获需 user 一次账号 OAuth 或换 SDK-compatible 途径。
- **auth 实测（2026-09-18，agy 1.2.6）**：headless **不认纯 env ADC**——`GOOGLE_APPLICATION_CREDENTIALS`+`GOOGLE_CLOUD_PROJECT`+`GOOGLE_GENAI_USE_VERTEXAI`（乃至 `modelProvider` 变体）注入后 `models`/`-p` 仍强制 Antigravity OAuth；前置 = user TUI 登录一次，headless 用缓存 token（`~/.gemini/antigravity-oauth-token`）。adapter spawn 注入 auth env（值取自运行环境既有变量，不硬编码/不写 native settings）属 auth 面传递，不是 §5 home 重定向。`result` 错误信封已采样：`{event:"result",result:{conversation_id,status,response,error,duration_seconds,num_turns,usage{...}}}`。
- **§5/§13/§14 套用**：spawn 零重定向（`~/.gemini`）；lazy spawn（首 prompt 才物化）；`dsh-sessions.json` mapping only（conversationId 首轮才成立，同 §8 codex 缝）；DSH log 单一主笔；审批降级 launch-only（default / accept-edits / skip-permissions+`--sandbox` 三档）；model list 走 `agy models` manual 探针（§14-ii）。
- **前置**：user 交互登录一次（headless 用缓存凭据；2026-09-18 本机实测见上）。
