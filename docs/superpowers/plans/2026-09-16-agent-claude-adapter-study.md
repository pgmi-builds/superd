# Agent-Worlds AW-F — `agent-claude`（Claude Code）adapter 可行性研究（2026-09-16）

> **目的**：判明「用 Claude Code 官方 Agent SDK 把 Claude Code 接成一个完整、自洽的 dsh 世界 / 独立 app」的可行性、接线面、关键裁决与风险，产出可进入 `writing-plans` 的决策清单。
> **基准**：`upstream/deepseek-harness` @ `dsh-v0.1.5-rc.2`（物理 checkout）；SDK = `@anthropic-ai/claude-agent-sdk@0.3.263`（上游 subagent 包内 pinned）；本机 Claude Code CLI `2.1.261`。
> **姊妹件**：`.scratch/aw-codex/docs/agent-adapter-dev-rules.md`（适配器开发规则 §0–§13）、`docs/superpowers/plans/2026-09-16-agent-worlds-aw-b-plan.md`（已 revert，见 §0）、`apps/agent-worlds/agent-codex/`（同构先例）。

---

## 0. 现状锚点（先对齐，否则会照错误拓扑设计）

- `apps/agent-worlds` 主线 `main` HEAD = **`52ecc35`**。AW-B「单 origin 子路径挂载」**已 revert**，保存在分支 `aw-b-subpath-mount`（2026-09-15 判定为判断错误：客户端把 `/api`、`/api/remote.mux` 硬编码为根绝对路径 ⇒ shim/carrier 复杂度失控）。**本文件不建立在 AW-B 设计之上。**
- 现役拓扑 = **legacy selector + 进程内委托**：
  - ctx0（`:4999`）= hub + selector（`agent-hub/src/client/RuntimeSeat.tsx` POST `/api/agent-runtime`）；
  - 每个 world = **独立进程 + 独立 DSH_HOME**（`test/start-world-4998.sh`；`52ecc35` 修掉 4999/4998 identity collision）；
  - selector 经 hub `registerForeignTarget` + `typertGateway` 两方法**进程内委托**（零 HTTP、零字节代理，S4）；
  - world 本身也起 listener（4998 或 0），便于独立调试。
- 已有适配器：`agent-omp`（现役）、`agent-codex`（untracked 新线，`./world` export + `world-plugin.ts` 已就绪）。
- ⇒ claude adapter 的目标 = 与 codex **同构**的第三个 adapter：`@pgmi-builds/agent-adapter-claude`。

---

## 1. 结论摘要（TL;DR）

1. **SDK-first 成立，且显著优于 CLI 线**。`@anthropic-ai/claude-agent-sdk` 是 Claude Code 的官方**进程内控制面**，覆盖面远超 codex-sdk：不只是 one-shot，还含多轮、steer/interrupt、模型与权限档热切、审批回调、hooks、会话清单/回放/fork。
2. **上游已有同源实现可抄**：`upstream/deepseek-harness/packages/subagent/subagent-claude-code`（v0.1.5-rc.2）已把「官方 `query()` + `spawnClaudeCodeProcess` 接到 dsh subprocess seam + `canUseTool` 拒绝回调 + `permissionMode` 5 档」跑通并有测试。我们要做的是把 **one-shot 扩成 multi-turn 长活会话**。
3. **claude 比 codex 好接的三处**（直接改进 codex 的已知降级）：
   - Claude 的 session id 在**首个 turn 之前**就存在（`system/init.session_id`），且 SDK 允许**预设 UUID**（`Options.sessionId`）⇒ 有机会**免 mapping 表**地把 DSH session 锚定到 Claude session；
   - **真运行时审批**存在（`canUseTool` / `onElicitation` / `onUserDialog` / `supportedDialogKinds`）⇒ 不必像 codex 降级成 launch-only 三档预设；
   - **app-wide 会话面有官方 API**（`listSessions` / `getSessionMessages` / `getSubagentMessages` / `listSubagents` / `forkSession` / `deleteSession` / `renameSession` / `getSessionInfo`）⇒ 不靠扫描原生 JSONL 做清单/回放。
4. **session id 可锚定（静态取证已支持，仍需一次真机确认）**：DSH session id 形如 `session-<uuid>`，Claude 侧接受**版本无关的通用 UUID**（`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`，SDK 与 CLI 两处逐字一致）；**v7 被接受**。⇒ 有机会免映射表。详见 §5.2。
5. **superpowers 技能匹配**见 §9：`brainstorming`（含 `grilling`）→ `writing-plans` → `test-driven-development` → `subagent-driven-development` 或 `executing-plans` → `verification-before-completion`；域技能 `dsh-dev-skill` + `cordis-plugin-development`。

---

## 2. 目标形态（规则 §1，两种都必须能跑）

| 形态 | 组成 | 端口 | 现成模板 |
|---|---|---|---|
| **A. standalone app**（开发/验收首选） | 单 dsh 进程，composition = `dsh-base` + `dsh-web-app` + `@pgmi-builds/agent-adapter-claude` | 自有 loopback 口：**4989**（实测 4986/4987/4988/4998/4999 全被占） | `apps/agent-worlds/test/start-codex-app.sh` |
| **B. world ctx**（hub 桥） | 独立进程 + 独立 DSH_HOME，profile = base + web-app + adapter；ctx0 hub 经 `registerForeignTarget` 委托 | **0（ephemeral）**；world 走进程内委托、不需可寻址端口（4998 被旧 omp world 占用） | `test/start-world-4998.sh` + `agent-claude/src/world-plugin.ts` |

- 差异**只允许**来自 patch 层注入（端口、home、注入行），**不允许**两份代码路径（规则 §1）。
- 形态 B 的 world 必须同时是**形态 A 可跑的**（规则 §2 测试准则 1：先 standalone，再 hub）。
- 客户端面：`window.__DSH_BOOT__.entries` 由**服务 HTML 的那一侧**静态产出（规则 §4.1）⇒ 形态 A 下 adapter 自己服务 HTML；形态 B 下 client surface 仍需能在形态 A 正确交付。

---

## 3. Claude Code 官方 SDK 面（逐项证据）

**证据文件**：`upstream/deepseek-harness/packages/subagent/subagent-claude-code/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`（8804 行类型声明全文）。

### 3.1 入口与生命周期

```ts
query({ prompt: string | AsyncIterable<SDKUserMessage>, options?: Options }): Query   // sdk.d.ts:2953
interface Query extends AsyncGenerator<SDKMessage, void> { … }                        // sdk.d.ts:2601
```

- **one-shot 模式**：`prompt` 传 string（上游 subagent 用法）。
- **multi-turn 长活模式（adapter 必需）**：`prompt` 传 `AsyncIterable<SDKUserMessage>`（**streaming input mode**），配合 `Query.streamInput(stream)` 追加用户消息。**`interrupt` / `setModel` / `setPermissionMode` / `supportedModels` / `mcpServerStatus` / `setMcpServers` 全部标注 "only supported when streaming input/output is used"** ⇒ adapter 的 steer / 打断 / 运行中换模型与权限档**只能**走这条模式。

`Query` 控制面（`sdk.d.ts:2601-2951`，完整方法名）：

```
interrupt                         setPermissionMode        setMcpPermissionModeOverride
setModel                          setMaxThinkingTokens     applyFlagSettings
updateSettings                    reinitialize             reloadPlugins
reloadSkills                      reloadOutputStyles       rewindFiles
seedReadState                     getContextUsage         usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
accountInfo                       initializationResult     supportedModels
supportedCommands                 supportedAgents          mcpServerStatus
reconnectMcpServer                toggleMcpServer          setMcpServers
backgroundTasks                   stopTask                 readFile
streamInput                       close                    options?
```

### 3.2 `Options` 关键字段（`sdk.d.ts:1396` 起，全量 60+）

**接线必需**：`cwd`、`model`、`effort`、`thinking`、`fallbackModel`、`systemPrompt`、`agent`、`agents`、`skills`、`plugins`、`tools`、`allowedTools`、`disallowedTools`、`mcpServers`、`strictMcpConfig`、`settingSources`、`settings`、`managedSettings`、`env`、`abortController`、`title`、`includePartialMessages`、`stderr`、`debug`、`extraArgs`。

**会话生命周期**：`resume`（:1925）、`sessionId`（:1927-1931，「Use a specific session ID for the conversation instead of an auto-generated one. **Must be a valid UUID**」）、`forkSession`、`continue`、`resumeSessionAt`、`persistSession`、`sessionStore`、`sessionStoreFlush`。

**安全/交互**：`permissionMode`（:2317，`'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`）、`allowDangerouslySkipPermissions`、`canUseTool`（:209）、`onElicitation`、`onUserDialog`、`supportedDialogKinds`、`permissionPrompts`、`permissionPromptToolName`、`sandbox`。

**进程**：`pathToClaudeCodeExecutable`、`spawnClaudeCodeProcess(options: SpawnOptions): SpawnedProcess`、`executable`、`executableArgs`、`loadTimeoutMs`。

**预算/轮次**：`maxTurns`、`maxBudgetUsd`、`taskBudget`、`retry`。

**checkpoint**：`enableFileCheckpointing` + `Query.rewindFiles`。

### 3.3 `SDKMessage` 词表（`sdk.d.ts:4681`，41 个变体）

```
SDKAssistantMessage           SDKUserMessage / SDKUserMessageReplay      SDKResultMessage(Success|Error)
SDKSystemMessage(init)        SDKPartialAssistantMessage(stream_event)    SDKCompactBoundaryMessage
SDKStatusMessage              SDKAPIRetryMessage                          SDKControlRequestProgressMessage
SDKModelRefusalFallbackMessage / NoFallbackMessage                        SDKLocalCommandOutputMessage
SDKHookStartedMessage / HookProgressMessage / HookResponseMessage         SDKPluginInstallMessage
SDKToolProgressMessage        SDKAuthStatusMessage                        SDKTaskNotificationMessage
SDKTaskStartedMessage / TaskUpdatedMessage / TaskProgressMessage          SDKBackgroundTasksChangedMessage
SDKThinkingTokensMessage      SDKSessionStateChangedMessage               SDKWorkerShuttingDownMessage
SDKCommandsChangedMessage     SDKNotificationMessage                      SDKFilesPersistedEvent
SDKToolUseSummaryMessage      SDKMemoryRecallMessage                      SDKRateLimitEvent
SDKElicitationCompleteMessage SDKPermissionDeniedMessage                  SDKPromptSuggestionMessage
SDKMirrorErrorMessage         SDKInformationalMessage                     SDKConversationResetMessage
```

关键结构（直接决定 DSH 事件映射）：

| 消息 | 关键字段 | DSH 落点 |
|---|---|---|
| `system/init`（:5148） | `session_id`、`claude_code_version`、`cwd`、`tools`、`model`、`permissionMode`、`slash_commands`、`skills`、`plugins`、`mcp_servers`、`agents`、`output_style`、`effort`、`capabilities`、`apiKeySource` | 会话 runtime metadata、slash/skills/mcp 面板、ctx 上限 |
| `assistant`（:3318） | `message: BetaMessage`、`parent_tool_use_id`（**子 agent 嵌套**）、`uuid`、`session_id`、`error?`、`supersedes?`、`aborted?`、`context_usage?` | `assistant/message`（reasoning 在 content blocks 内） |
| `stream_event`（:4826） | `event: BetaRawMessageStreamEvent`、`ttft_ms` | 实时增量（`assistant/message.stream`） |
| `user`（:5365） | `message`、`parent_tool_use_id`、`tool_use_result?`、`isSynthetic?`、`origin?`（human/channel/peer/task-notification） | `user/message` / `tool/result` |
| `system/compact_boundary`（:3430） | `compact_metadata{trigger,pre_tokens,post_tokens,duration_ms,preserved_*} ` | `compaction/*` |
| `result` success（:5005） | `usage`、`modelUsage{…,contextWindow,maxOutputTokens,costUSD}`、`total_cost_usd`、`num_turns`、`duration_ms`、`duration_api_ms` | 轮次结束 + usage |
| `result` error（:4957） | `subtype: error_during_execution\|error_max_turns\|error_max_budget_usd\|error_max_structured_output_retries`、`permission_denials[]`、`errors[]` | `turn/end{reason:{kind:'error'}}` |
| `system/permission_denied` | `tool_name`、`tool_use_id`、`decision_reason_type` | 审批审计事件 |

### 3.4 app-wide 能力（codex-sdk **完全没有**的那一层）

```ts
listSessions({dir?, limit?, offset?, includeWorktrees?, includeProgrammatic?, sessionStore?}): Promise<SDKSessionInfo[]>  // :992
getSessionInfo(sessionId, opts): Promise<SDKSessionInfo | undefined>                                                       // :767
getSessionMessages(sessionId, opts): Promise<SessionMessage[]>                                                             // :797
listSubagents(sessionId, opts): Promise<string[]>                                                                          // :1047
getSubagentMessages(sessionId, agentId, opts): Promise<SessionMessage[]>                                                   // :834
forkSession(sessionId, opts): Promise<ForkSessionResult>                                                                   // :738
deleteSession(sessionId, opts): Promise<void>                                                                              // :568
renameSession(sessionId, title, opts): Promise<void>                                                                       // :2963
importSessionToStore(sessionId, store, opts): Promise<void>                                                                 // :895
foldSessionSummary(...)                                                                                                     // :720
```

`SDKSessionInfo`（:5059）：`sessionId / summary / lastModified / fileSize? / customTitle? / firstPrompt? / gitBranch? / cwd? / tag? / createdAt?` ⇒ **DSH 侧会话清单/标题/cwd/分支可直接映射**，不必解析 JSONL。

`SessionStore`（:5601）接口 `append / load / listSessions? / …` + `InMemorySessionStore`（:932）⇒ SDK 允许**替换持久化后端**（默认落 `~/.claude/projects/**/<sessionId>.jsonl`）。**这是可选项而非必选**：`resume` 依赖磁盘 transcript（claude-in-dsh 实践：`--resume` 对不存在的 transcript 是 fatal），故 V1 **保持原生持久化开启**（见 §5.3）。

### 3.5 hooks（33 个事件，:854）

```
PreToolUse  PostToolUse  PostToolUseFailure  PostToolBatch  Notification  UserPromptSubmit
UserPromptExpansion  SessionStart  SessionEnd  Stop  StopFailure  SubagentStart  SubagentStop
PreCompact  PostCompact  PreModelSwitch  PostModelSwitch  PermissionRequest  PermissionDenied
Setup  TeammateIdle  TaskCreated  TaskCompleted  Elicitation  ElicitationResult  ConfigChange
WorktreeCreate  WorktreeRemove  InstructionsLoaded  CwdChanged  FileChanged  DirectoryAdded  MessageDisplay
```

用途：`SubagentStart/Stop` → DSH `subagent/*`；`PreCompact/PostCompact` → `compaction/*`；`PermissionRequest/Denied` → 审批审计；`SessionStart/End`/`Stop` → turn 生命周期兜底；`TaskCreated/TaskCompleted` → todo/plan 面。

### 3.6 认证与原生 home 事实（本机实测）

- `CLAUDE_CONFIG_DIR` 被 CLI 支持（二进制 env 注册表成员）；`ANTHROPIC_CONFIG_DIR`、`CLAUDE_SECURESTORAGE_CONFIG_DIR`、`CLAUDE_CODE_PLUGIN_CACHE_DIR`、`CLAUDE_CODE_PLUGIN_SEED_DIR` 同在。
- 该变量**必须是绝对路径**；**启动后变更会被拒绝**（字符串：`the configuration home (CLAUDE_CONFIG_DIR) is not an absolute path` / `… changed after Claude Code started: set it in the shell, not a settings file, and restart`）⇒ 只能在 spawn 的 env 里注入，**不能**写进 settings。
- `.claude.json` **与 `.credentials.json` 都解析到配置 home 下**（`$CLAUDE_CONFIG_DIR/.claude.json`、`$CLAUDE_CONFIG_DIR/.credentials.json`），user settings = `$CLAUDE_CONFIG_DIR/settings.json`（SDK 侧 `{globalConfig: <dir>/.claude.json, userSettings: <dir>/settings.json}` 相互印证）⇒ 重定向会一并搬走 `~/.claude.json`（含 MCP servers、projects）与凭据；`~/.claude/.credentials.json` 仅在变量未设时作为回落。
- **SDK 平台载荷（本地实证）**：`@anthropic-ai/claude-agent-sdk-linux-x64@0.3.263` 存在且**可执行**（215 MB）；SDK 默认解析该载荷，**无 PATH / 宿主 `claude` 回落**（`Native CLI binary for ${platform}-${arch} not found. Reinstall … without --omit=optional, or set options.pathToClaudeCodeExecutable.`）；传输 = 子进程 stdio，argv `--output-format stream-json --verbose --input-format stream-json`，唯一替代是 `spawnClaudeCodeProcess`（仍是子进程）。
- 本机 `~/.claude/settings.json` 的 `env` 段已把 Claude Code 指向 DeepSeek 的 Anthropic 兼容端点（`ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` + `ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU}_MODEL` 别名）⇒ **本机认证是 settings 型而非 OAuth 型**（密钥值不外泄到本文档）。
- 模型目录可被 `CLAUDE_CODE_MODEL_CATALOG` / `CLAUDE_CODE_MODEL_CATALOG_URL` 覆盖。
- 上游 subagent 包 README 原话：「The platform-pinned runtime starts on demand and **never falls back to the host `claude` executable**」⇒ SDK 自带平台二进制载荷（pnpm store 内确认为 `@anthropic-ai/claude-agent-sdk-linux-x64@0.3.263`），与宿主 CLI 版本解耦。

---

## 4. 与 agent-codex 的对照（为什么 claude 更容易）

| 维度 | agent-codex（现状） | agent-claude（本研究） |
|---|---|---|
| SDK 能力 | `@openai/codex-sdk`：startThread/resumeThread/runStreamed，**无 app-wide** | 官方 Agent SDK：one-shot + **streaming multi-turn** + 控制面 + **全套会话 API** + hooks |
| session id 时点 | threadId **首 turn 后**才成立 ⇒ 必须有 `dsh-sessions.json` 映射 | `session_id` 在 init 就有，且可**预设 UUID** ⇒ 有机会免映射（§5.2） |
| 会话清单 | **adapter 扫 rollout** | 官方 `listSessions` / `getSessionInfo` |
| 回放 | rollout 解析（已弃用，改 DSH-native） | `getSessionMessages` / `listSubagents` / `getSubagentMessages` |
| fork | **无** | `forkSession` |
| 审批 | **降级**：launch-only 三档 `--approval-mode` | **真回调**：`canUseTool` → DSH approval |
| 提问/选项 | 无 | `onUserDialog` + `supportedDialogKinds` + `Elicitation` hook |
| plan | 无 | `permissionMode: 'plan'` + `ExitPlanMode`（claude-in-dsh 已证可桥到 DSH plan-review） |
| 运行中换模型 | 下一轮生效 | `Query.setModel()`（**立即**，streaming 模式） |
| 打断/插话(steer) | 无（仅排队 followUp） | `Query.interrupt()` + `streamInput` 追加 |
| 用量 | SDK usage 滞后一轮 | `result.usage` + `modelUsage`（含 `contextWindow`/`cache*`/`costUSD`）+ `getContextUsage()` |
| 压缩 | 未接 | `CompactBoundary` + `Pre/PostCompact` hooks |
| 进程归属 | SDK 自管 | `spawnClaudeCodeProcess` 可挂到 dsh subprocess seam（上游已示范） |

⇒ **codex 的 V1 降级清单里，claude 至少能消掉 5 项**（审批、fork、steer、立即换模型、会话清单）。

---

## 5. 关键裁决（决定计划形状）

### 5.1 Home（规则 §5 + §13 红线）

- **app home = `$DSH_HOME/agents/claude`**（原生 app 自身数据），**profile = `$DSH_HOME/profiles/claude`**，`<label> = claude`。禁止自造 per-app home（`.superd-test/codex-app` 是先例违规，已删）。
- 重定向手段 = spawn env 里的 **`CLAUDE_CONFIG_DIR=<app home>`（绝对路径）**。它会连带搬走 `settings.json`、`projects/**` transcript、`skills/`、`plugins/`、`history.jsonl`、`.claude.json`。
- **单向阀（只读拷入）**：`~/.claude` 永不回写。首启动拷入的最小集 = `settings.json`（**本机认证正在这里**）+ `CLAUDE.md`（若用）+ 可选的 `skills/`、`agents/`、`commands/` 目录**或**改走 `CLAUDE_CODE_PLUGIN_SEED_DIR` / `CLAUDE_CODE_PLUGIN_CACHE_DIR` 播种。实现形态照抄 `agent-codex/scripts/setup-codex-home.mjs`（幂等 + **prod home 拒绝守卫**：`~/.dsh`、`~/.superd`、以及 source 不得等于 app home）。
- **session cwd = 用户 workspace**，**绝不**指到 app home（规则 §5 红线）。
- DSH 级状态（workspace 注册表、settings、session log）与 Claude 原生数据**分账**，各自 owner 明确。

### 5.2 Session identity（本研究的核心机会）

- DSH session id 形如 `session-<uuid>`（实测：`.superd-test/storages/session_projcache/sessions/session-01a04826-6d1d-701f-adc3-b834dffc82c5.json`；`packages/core/session/src/index.ts:965` 在 store 自铸时用 `session-${++counter}`）。
- Claude 侧要求 UUID。因此：
  - **路线 A（首选）**：`claudeSessionId = dshSessionId` 去掉 `session-` 前缀。create 时 `query({ options: { sessionId } })` 预设；resume 时 `options.resume = claudeSessionId`。**收益：零映射表，重启后 id 稳定** —— 直接消掉 dev rules §8 记录的那条「进程内 `threadIdIndex` 跨重启漂移」缝。
  - **路线 B（兜底）**：DSH id 不是合法 UUID（如测试里的 `session-1`、或 harness 铸的其它形态）时，让 SDK 自铸，并把映射写进 `<appHome>/dsh-sessions.json`（照抄 `agent-codex/src/session-map.ts`）。
- **静态取证已支持路线 A（HIGH），但仍需一次真机确认**：谓词是版本无关正则（见 §1.4），故 v7 应被接受。**纠正本文件早前的判断**：先前据二进制内 `Invalid UUID version:` / `Invalid UUID received:` 推断「可能只收 v4」是**错误的**——那几条属于 Zod v4 `$ZodUUID` 与 `@azure/msal-node` 的 `isGuid`，**不是** session-id 校验路径；session-id 路径用的是上引通则，另有独立的字符安全守卫（`Session IDs must not contain unsafe characters.`）。
- **T0 仍要跑**（一次真 turn 即可同时满足验收）：确认 `query({options:{sessionId:<DSH 派生的 UUIDv7>}})` 被接受且 `system/init.session_id` 回读一致；不通过则退路线 B。

### 5.3 会话持久化：DSH-native（沿用 codex 2026-09-16 裁定）

- DSH 侧：**启用上游 `session-persistence-jsonl`**，工厂持写通道（`sessionPersistence.create(session.header,{inheritedEventCount})` / `open(id,'write')` + `handle.read()`），list/replay/冷读全由 DSH 服务提供（`agent-codex/src/index.ts` 的 `createStoredSession` / `setupAndPublish` 即模板）。
- Claude 侧：**`persistSession: true`**（默认）——`resume` 需要磁盘 transcript；adapter 的唯一读取是 §3.3 的元数据面，不是 transcript replay。
- **接受的代价（显式登记）**：会话存储**双份**（DSH log + Claude `projects/**/<id>.jsonl`），两处都真实存在、不是 bug（dev rules §8）。

### 5.4 审批 / 提问 / plan（claude 的真实优势）

| 面向用户的请求 | Claude 侧 | DSH 落点 |
|---|---|---|
| 工具权限 | `canUseTool(toolName, input, {signal, toolUseID, suggestions, decisionReason, …}) → allow/deny/ask` | DSH 原生审批 UI（`approval/asked|decided`） |
| 权限档 | `Query.setPermissionMode(mode)`（运行中可切） | DSH access-mode 选择器（原 5 档 → DSH 3 档 + `plan`/`auto` 扩展的映射表须落档） |
| 提问 / 选项 | `AskUserQuestion`（**模型发起的工具**）需在 `disallowedTools` 之外**放开**才能被桥；`onUserDialog` + `supportedDialogKinds` 是**另一条**（CLI 发起的 dialog）——V1 不声明，见 §6.5 | DSH 提问服务（选项/多选/自由文本） |
| MCP elicitation | `onElicitation` | 同上或显式 decline |
| plan 审核 | `permissionMode: 'plan'` + `ExitPlanMode` | DSH plan-review 卡片（批准 ⇒ 退出 plan 并把权限档落回监督档） |
| 权限拒绝审计 | `system/permission_denied` + `PermissionDenied` hook + `result.permission_denials` | log-only 事件 |

⚠️ 与上游 subagent 的**相反选择**：上游 one-shot 刻意 `disallowedTools:['AskUserQuestion'(,'ExitPlanMode')]` + `canUseTool → deny`（无人值守）。**adapter 必须反过来**：放开这两个工具、把 `canUseTool` 接到真实审批（fail-closed：无 asker ⇒ deny）。

### 5.5 模型目录与 app-wide settings

- 目录来源（真实为准）：`Query.supportedModels(): ModelInfo[]`（`value/displayName/description/supportsEffort/supportedEffortLevels/supportsAdaptiveThinking/supportsFastMode/supportsAutoMode`）+ `supportedCommands()` / `supportedAgents()` + `system/init` 的 `skills/plugins/mcp_servers/slash_commands`。
- 喂给 DSH 的 `LlmAdapter`（照抄 `agent-codex/src/adapter.ts`）：`providerInfo/listModels/resolveModel` 读上述快照，`stream()` 抛 `UNSUPPORTED_STREAM`（Claude 自己驱动生成，绝不伪造 wire 路由）。**占位/降级值禁止外流**（规则 §6）：`claude-default` 之类不得写进 settings、不得传给真实 runtime。
- app-wide 默认模型推送 `agentDefaultModel.saveSelection()`：**单向粘性**，且只在目录可读时推。
- runtime 元数据：`session_meta` 等价物 = `system/init`（`cwd`/`model`/`permissionMode`/`tools`/版本）+ `system/status` + `result.modelUsage[].contextWindow` → DSH session/runtime metadata + ctx 上限。

### 5.6 会话生命周期（照抄 Codex/OMP 的既有做法，非新发明）

**adapter 本身是常驻守护进程**（随 app 启动），与宿主 web app 同构。真正需要裁决的生命周期在 **SDK client 层**，而 Codex/OMP 已给出同一套答案：

1. **构造零 IO**：`createAgent` 只建占位（OMP：`new LazyOmpRpc(...)`，`agent-omp/src/index.ts:378`，契约注释 `:371-377`「no OMP child, no transcript, no index row, no session events… The child materializes on the first prompt」）。
2. **首 prompt 才物化**：冷启点在 `#startTurn` 内（OMP `src/agent.ts:549` `await this.#rpc.ensureStarted()`；Codex `src/agent.ts:520` 同形）。
3. **resume 只重挂、不驱动轮次**：读 DSH log → 重挂 runtime 侧会话文件 → 发布；**不**发 prompt（OMP `src/index.ts:407-491`，`:468` `--resume <file>`；意图注释 `:412-413`「never feed the old dsh transcript back to OMP」）。
4. **idle TTL 拆除 + fire 时复核**：OMP 默认 **`OMP_IDLE_EXIT_MS = 600_000`（10 分钟；不是 30 分钟）**，`0` 关闭（`agent-omp/src/agent.ts:241,251-255`）；`#markIdle` arm、任何活动 cancel，`unref()`；fire 走 `#revalidateIdleExit()`（代码自称 "Five-fold quiescence re-validation"，`src/agent.ts:879-911`）——逐条 re-arm：disposed/streaming、never-spawned draft（不 re-arm，直接放弃）、未发送的排队投递、pending approval、`getState()` 的 isStreaming/isCompacting/queuedMessageCount、`getSubagents()` 存活性。**注意**：代码里不存在「恰好五个具名关卡」的硬契约，也没有 "open step" 关卡。

⇒ claude adapter 沿用同一套；`abortController` + `Query.close()` + `spawnClaudeCodeProcess` 挂 dsh subprocess seam，grace tier 照抄上游 `packages/subagent/subagent-claude-code/src/process.ts`。**「broker 保活」不再作为选项出现**（那是 claude-in-dsh 的 CLI 文件协议，与本线 SDK 桥形态无关）。
- **执行体归属是 user 的决策，不是研究结论**：`pathToClaudeCodeExecutable` 指宿主 `claude` 还是用 SDK 自带平台载荷——见 §5.6 之后的 Q5 选项清单。
- 另需裁决：是否把 SDK 的 `pathToClaudeCodeExecutable` 钉到**平台载荷**（默认，版本可控）而非宿主 `claude`（2.1.261，会漂）。

### 5.7 client 面交付（规则 §4.1）

- 形态 A：HTML 由 adapter 自己服务的 composition 产出 ⇒ `dsh.client` 声明 + **产物已构建**二者缺一不可。
- 需要「应用内」能力（目录选择器）时：pin 具体 face（如 `browse` 的 host + client 两面）并 unmount stock `*-auto` 行；**不要** `disabled: true` 掉 stock 行本身。codex 的 `cordis.patch.yml` 已把这套配方写死，可整段复用。
- 若要做「引擎选择器」（DSH | Claude）这类 UI，属 DSH per-agent 定制权（规则 §12），落 adapter 自身层，**不上提为线/hub 规则**。

---

## 6. 接线域逐项裁决表（规则 §3；缺项必须显式登记）

| # | 接线域 | 供给方 | 实现要点 | 风险/现状 |
|---|---|---|---|---|
| 3.1.1 | spawn / resume | SDK | `query({options:{sessionId}})` / `resume`；streaming input 保活；失败面（transcript 不存在、UUID 非法）fail-closed | transcript 缺失时 `resume` fatal（需预检） |
| 3.1.2 | events → dsh | SDK 消息 + adapter 投影 | `projectClaudeEvent()`：init/assistant/stream_event/user/result/compact_boundary/permission_denied → DSH 词汇；`parent_tool_use_id` → `subagent/*` 嵌套 | 41 变体需逐项分类（接/降级/忽略） |
| 3.1.3 | 系统提示 | SDK `systemPrompt` / `system/init` | DSH `system/message`（surface 节点 0） | 文本来源须取实（不伪造） |
| 3.1.4 | thinking/reasoning | `assistant.message.content` 的 reasoning block + `stream_event` | DSH `assistant/message.content[{type:'reasoning'}]`（**不是 `thinking`**）+ `assistant/message.stream` | 与上游事件词汇一致 |
| 3.1.5 | 工具调用/结果 | `assistant` tool_use / `user.tool_use_result` | `tool/call` + `tool/result`（按 `tool_use_id` 配对） | 与 codex 一致 |
| 3.1.6 | compaction | `compact_boundary` + Pre/PostCompact hooks | `compaction/*` | 长会话必需 |
| 3.1.7 | job list / background | `backgroundTasks()`、`TaskStarted/Updated/Progress/Notification` | DSH job 面 | 部分未接，须登记 |
| 3.1.8 | subagent | `SubagentStart/Stop`、`parent_tool_use_id`、`listSubagents` | `subagent/*` 嵌套渲染 | 比 codex 强 |
| 3.1.9 | todo/plan | TaskCreated/Completed、`ExitPlanMode`、`planModeInstructions` | `todo/write`、`plan/mode`、plan-review | 需实测 |
| 3.1.10 | turn 生命周期 | `system/session_state_changed(idle/running/requires_action)` + Stop/StopFailure + result | `turn/start` / `turn/end{reason}` | 以 session_state_changed 为准（权威 turn-over 信号） |
| 3.1.11 | model list / 切换 | `supportedModels()` + `setModel()` | LlmAdapter 目录 + 运行中立即切换 | 优于 codex |
| 3.1.12 | cwd / workspace | `Options.cwd` + `SDKSessionInfo.cwd` | 会话 cwd = 用户 workspace；workspace 注册表归上游 `dsh-workspace` | **红线**：不指 app home |
| 3.1.13 | slash / skills / mcp / plugins | `init.slash_commands`、`skills`、`plugins`、`mcp_servers`、`supportedCommands()`、`mcpServerStatus()`、`reloadSkills()` | 面向用户的能力面板 + 斜杠命令 | 需裁决「一次性命令带外执行」是否做 |
| 3.1.14 | 审批 / 交互 | `canUseTool`、`onUserDialog`、`onElicitation`、`PermissionRequest` hook | DSH 审批 + 提问服务（fail-closed） | §5.4 |
| 3.1.15 | session metadata | `SDKSessionInfo`、`system/init`、`renameSession` | 标题/preset/权限档/时间 | 标题可用 `customTitle`/`summary` |
| 3.1.16 | runtime metadata / usage | `result.usage`、`modelUsage`、`getContextUsage()`、`RateLimitEvent` | DSH usage + ctx 上限 + 配额行 | 比 codex 实时 |
| 3.2.1 | settings / config 读写 | 原生 settings 文件 + hooks `ConfigChange`、`Query.updateSettings` | 单向阀：读 native、写 app home；**哪些可写须列白名单** | 本机 auth 在 settings，拷贝策略需裁决 |
| 3.2.2 | agent-preset 设施 | SDK `agents` / `agent` / `skills` / `plugins` / `tools` | DSH preset/roster 投影；单 preset 或映射原生 agents | 照抄 codex 的 `SingleCodexPresetRoster` 形态 |
| 3.3.1 | readiness | SDK 载荷是否存在 + `claude_code_version` + `apiKeySource` | 启动前探测，失败**响亮**且留痕 | 禁静默假成功 |
| 3.3.2 | session 管理 | SDK session APIs + `sessionStore` | lazy spawn（构造零 IO，首 prompt 才物化）；idle TTL；resume 前 replay | 策略须落档 |

---

## 6.5 DSH 原生交互面（穷举否证）与 Claude→DSH 最终映射

**穷举否证**：全树 human-interaction waterfall **恰好两个** —— `approval/request` 与 `user-questions/request`。**不存在**任何通用 "extension UI / dialog" 面（`user/*`、`interaction/*`、`ui/request`、prompt/confirm 服务均不存在；`cordis/request-run` 只授权插件包运行，不是提问面）。⇒ dev rules §3.1 写的「选项/交互（extension UI 类）」在 DSH 里**没有对应实现**，该条描述的是一个不存在的面。

| Claude 原语（发起方） | DSH 确切落点 | 证据 |
|---|---|---|
| `canUseTool(name, input, opts)` → `{behavior:'allow'\|'deny', updatedInput?, updatedPermissions?}` | `ctx.approval.request({agent, toolName, callId?, reason?, signal?})` → `ApprovalOutcome = 'allowed-once'\|'rejected'\|'cancelled'\|'unavailable'`；事件 `approval/asked` / `approval/decided` / `approval/policy` | `interaction/user-approval/src/index.ts:142,207`；`types.ts:32,44-58` |
| `AskUserQuestion`（**模型**发起） | `ctx.userQuestions.ask({questions:[{id, question, header?, options?:[{label, description?}], **multiSelect**?}]})` → `{answers:[{id, selected[], custom?}]}` | `interaction/user-questions/src/types.ts:45`（**服务契约是 camelCase `multiSelect`**）；`interaction/user-questions/src/index.ts:86`；`interaction/tool-ask-user/src/index.ts:50,87` |
| `ExitPlanMode`（模型）+ `permissionMode:'plan'` | **同一条** `ask()`，`detail = plan`、`intent = {kind:'plan-review', approve:'Approve'}` | `plan/plan-mode/src/index.ts:300-316` |
| `streamInput()` 插话 | `agent.steer(msg)`（= `send(msg,'next-step',true)`） | `core/agent/src/runtime-types.ts:231`；`core/agent-loop/src/agent.ts:141-147` |
| 排队 | `agent.followup(msg)`（= `'next-turn'`） | `runtime-types.ts:222` |
| `Query.interrupt()` | `agent.cancel({kind:'user'}, {keepInbox:true})` → `turn/end{reason:{kind:'aborted'}}` | `runtime-types.ts:183`；`api/session-controller/src/commands.ts:509` |
| `supportedCommands()` 的本地命令 | `ctx.commands.register(def)`；`@Remote list` / `@Remote execute`；已有程序化执行先例 | `interaction/commands/src/index.ts:280,309-361` |

**三处纠错**：① 服务名是 `ctx.approval`，**不是** `ctx.userApproval`；② **两个面的字段名不同，别混**——DSH 自有工具 `ask_user_question` 的**模型可见 schema** 用 snake_case `multi_select`（`tool-ask-user/src/index.ts:50`），而 **`ctx.userQuestions.ask()` 服务请求**用 camelCase **`multiSelect`**（`user-questions/src/types.ts:45`），二者由 `tool-ask-user/src/index.ts:87` 显式翻译。本 adapter 桥的是 **Claude 的 `AskUserQuestion` 工具输入**（本身即 camelCase `multiSelect`）→ **DSH 服务请求**，**两侧都是 `multiSelect`，全程无 snake_case**（原稿把工具 schema 的名字安到了服务契约上，已更正）。另：**无输入侧 "other" 标记**——自由文本是**输出**的 `custom`。

### dialogKind 的最终姿态（**推翻**本文件早前的 Q12b 建议）

`supportedDialogKinds` **不是**能力声明，而是**承诺**：声明某 kind = 告诉 Claude runtime core「本会话有这个 UI」，其运行时逻辑据此**走 dialog 分支并在 deadline 前 park 等回答**。反之**不声明 = fail-closed**：CLI 根本不发该 kind，流程降级为**已定义的** no-dialog 行为（对 `refusal_fallback_prompt` 即「经典 refusal 错误结束该轮」，我们能正常投影）。

⇒ **declared-but-unwired 是 fail-open + 悬挂（严格更差）；absent 是 fail-closed + 行为已定义（严格更好）。** 早前「声明它 + 未知 kind 静默」的建议在机制上自相矛盾（对**已声明**的 kind 沉默 = 把 runtime 引入一条我们服务不了的分支），**作废**。

**V1 姿态：`supportedDialogKinds` 与 `onUserDialog` 都不给** —— 原文「Omitting the option entirely means no dialogs are emitted, even with `onUserDialog` wired」。附带收益：`sdk.d.ts` 中 A 处（未知 kind 回 `cancelled`）与 B 处（绝不可回 `cancelled`）的矛盾**在 V1 直接无关**（收不到任何 kind），留待将来声明时按 B 处（协议层、更保守）处理。

**refusal 回退的正确接线：走两条 system 消息，不走 dialog。**

- `model_refusal_fallback {trigger:'refusal', direction, scope:'session'|'local', original_model, fallback_model, api_refusal_category?, api_refusal_explanation?, retracted_message_uuids?, refused_user_message_uuid?, content}`（`sdk.d.ts:4758-4788`）
- `model_refusal_no_fallback {original_model, api_refusal_category?, api_refusal_explanation?, refused_user_message_uuid?, content}`（`:4795-4806`）
- 两个**必须兑现**的字段：`retracted_message_uuids` = **从转录状态中驱逐**（幂等）；`refused_user_message_uuid` = rewind 目标 / composer 预填。
- `api_refusal_explanation` 文档原文：「**Unstable human prose — display only, never parse**」。
- 回退行为本身可用 `Options.fallbackModel`（`sdk.d.ts:1549`）预配置，**无需 dialog**。

⇒ 声明 `['refusal_fallback_prompt']` 降级为 **T0 取证项**：先抓真实实例学 `payload`（协议不解释 payload 形状），实现卡片并做完往返测试，**再**声明。

---

## 7. 先例（prior art，**不是参考实现**）：`claude-in-dsh`（CLI 线）

`https://github.com/GeekRicardo/claude-in-dsh` v1.8.0（本机快照 `.scratch/claude-in-dsh`，4733 行 host + 2261 行 client）走的是**CLI stream-json**：

```
claude -p --input-format stream-json --output-format stream-json \
       --permission-mode M [--model M] [--effort E] (--session-id | --resume) <uuid>
```
（`src/host.dynamic.js:15-18`、`:1494-1513`；broker 用 `setsid` 持有进程、fifo `in` + `out.log` 字节偏移续读，`:1043` 起）

**它的价值 = 一份现成的「接线域已做清单」**，可拿来对照我们的 SDK 线：

| 它做了 | SDK 线对应 |
|---|---|
| 引擎选择器（DSH \| Claude，按会话互斥、从 session log 推断） | per-agent 定制（规则 §12）；**我们不需要**——ctx0 selector 已在线 |
| 把流写成 DSH 持久会话事件（`assistant/chunk`、`tool/call`…） | §5.3 DSH-native |
| 权限档替换 access-mode + `can_use_tool` → DSH 审批 | `canUseTool` + `setPermissionMode` ✅ SDK 原生 |
| `AskUserQuestion` → DSH 提问卡片 | `onUserDialog` / hooks ✅ |
| `ExitPlanMode` → DSH plan-review | plan mode ✅ |
| 模型/effort 座 + 运行中 `set_model` | `supportedModels()` + `setModel()` ✅ |
| 命令面板并入 Claude slash 命令；一次性命令带外执行 | `init.slash_commands` / `supportedCommands()` ⚠️ 需裁决 |
| broker 进程托管（跨 dsh 重启保活） | §5.6 备选，V1 不做 |
| 订阅用量（5h/7d）+ 刷新倒计时 | `RateLimitEvent` + `accountInfo()` ✅ |
| 导入本机 Claude 对话 | `listSessions` / `getSessionMessages` ✅ |
| 断档补播、图片粘贴、子 agent 嵌套 | `resume` + `SessionStore` / content blocks / `parent_tool_use_id` |

**结论**：claude-in-dsh 证明「这些桥都值得做」；SDK 线能用**更少的手写协议**达到同等或更好（多出 fork、真审批、官方会话 API、进程 seam）。

---

## 8. 未接 / 降级登记（诚实清单，随实现更新）

1. **broker 级进程存活**（跨 adapter 重启保活）— V1 不做；重启后走 `resume`。
2. **`SessionStore` 自定义后端**（把 Claude transcript 灌进 DSH 存储）— 不做（违背「原生 log 为 runtime 权威」）。
3. **`Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`** — 明确实验性，不依赖。
4. **`rewindFiles` / file checkpointing** — 需 `enableFileCheckpointing`，与 DSH workspace 语义可能重叠，V1 登记不做。
5. **`plugins`/`skills` 的写面**（`reloadPlugins/reloadSkills`、`updateSettings`、`applyFlagSettings`）— 读面先接，写面等 settings 白名单裁决。
6. **team/channel/peer 类消息**（`SDKMessageOrigin` 的 channel/peer）— 忽略。
7. **`sandbox` option 与 DSH sandbox seam 的关系** — 两套沙箱语义，V1 以 Claude 原生为准并登记（不得声称已统一）。
8. **`threadSource`/多 runtime 并存**（DSH 原生 loop 与 Claude 同进程）— patch 层 disable 原生 loop（照抄 codex）。

---

## 9. superpowers 技能匹配与本研究的下一步

### 9.1 匹配的技能（按优先级）

| 技能 | 为什么匹配 | 何时用 |
|---|---|---|
| `superpowers:brainstorming`（含 `grilling`） | §10 的开放问题必须先被 grill 收敛（拓扑、认证、steer 语义、命令面板边界） | **现在**——进 plan 之前 |
| `superpowers:writing-plans` | 产出 `docs/superpowers/plans/YYYY-MM-DD-agent-claude-adapter-plan.md`，bite-size TDD 任务、每任务独立可测 + commit | brainstorming 收敛后 |
| `superpowers:test-driven-development` | 每个 adapter 模块（events 投影、session-map、permission 映射）先写失败测试 | 执行期逐步 |
| `superpowers:subagent-driven-development` / `executing-plans` | 任务量大（预估与 agent-codex 同量级 ~2.5k 行移植）——codex 线已验证 subagent 分工可行 | 执行期 |
| `superpowers:verification-before-completion` | 红线：**运行时行为验收**（standalone app 起真实例 + 浏览器/curl + 真 runtime turn），单测绿只是构建卫生 | 每阶段收尾 |
| `superpowers:systematic-debugging` | 桥接类 bug（shim、事件词表、resume 失败面）必然出现 | 触发时 |
| `superpowers:using-git-worktrees` | 建议与 codex 一样在独立 worktree 起线，避免污染主线 | 开工时 |
| `dsh-dev-skill`（域） | ch03/ch17（LlmAdapter、StreamChunk）、ch14（subagents）、ch16（projection/jobs）、ch02（bundle/patch） | 设计/实现查证 |
| `cordis-plugin-development`（域） | **动态 Cordis 插件**（`cordis_define`/`cordis_run`，host+client 纯 JS 半）——见 §9.3 的原型路线 | T0 原型 + 实现期

### 9.2 建议的任务序列（供 writing-plans 细化为 bite-size）

- **T0 事实钉死**：`query({options:{sessionId:<DSH 派生 UUIDv7>}})` 被接受且 `system/init.session_id` 回读一致（静态取证已支持，见 §5.2）；SDK 平台载荷在 app home 下能启动并返回 `system/init`。**注**：一次真 turn 即可同时满足 T0 与后续验收，不必单独 dry-run。
- **T1 包骨架 + 形态 A**：`packages/…/agent-claude`（`package.json` 的 `dsh.bundle.patch` + `./world` export）、`cordis.patch.yml`（mount provider + disable 原生 loop/llm 行 + permission 表 + browse picker）、`test/start-claude-app.sh`。
- **T2 home 单向阀**：`scripts/setup-claude-home.mjs`（`CLAUDE_CONFIG_DIR` 注入 + 拷入 settings + prod-home 守卫）。
- **T3 SDK 客户端**（`claude-client.ts`）：streaming input 保活、lazy spawn、resume、`spawnClaudeCodeProcess` → dsh subprocess seam、graceful dispose。
- **T4 事件投影**（`claude-events.ts` + 测试）：init/assistant/stream_event/user/result/compact/permission_denied → DSH 词汇；`parent_tool_use_id` 嵌套。
- **T5 CodexProvider 同构的 `ClaudeProvider extends Service implements AgentFactory`**：DSH-native 持久化（create/open/append/close）、session identity（§5.2 路线）、单 preset roster + 投影、模型目录 `LlmAdapter`。
- **T6 审批/提问/plan 桥**：`canUseTool` → DSH approval（fail-closed）；`onUserDialog` → 提问服务；plan review。
- **T7 形态 B**：`src/world-plugin.ts`（`spawnWorld` + `registerForeignTarget` + `setReady`）+ `agent-hub/test/fixtures/aw-claude-world/` + `start-world-<port>.sh`。
- **T8 运行时验收**：真 runtime turn + HTTP wire（create→prompt→readback）+ 重启后 list/replay/resume；token URL 交 user 并**保持运行**。

### 9.3 两条交付形态（先原型、后包）

`cordis-plugin-development` 揭示了一条值得显式登记的第二形态——**动态 Cordis 插件**（`cordis_define` / `cordis_run`，host 半 + client 半均为纯 JS、无 tsc/无构建、进程内临时、可热更回滚）：

| | **静态 adapter 包**（本线目标） | **动态 Cordis 插件**（原型手段） |
|---|---|---|
| 形态 | `@pgmi-builds/agent-adapter-claude`，`tsc → dist/`，`dsh.bundle.patch` + `./world` export | `cordis_define` 的一次 Package（host+client `apply`） |
| 适用 | 分发、形态 A/B 双形态、roster 在册（S2） | **T0/T3 的 SDK 事实钉死与事件投影试错** |
| 约束 | 规则 §6 全部纪律 | 进程内临时、不持久、不能作为交付物 |
| 先例 | `agent-omp` / `agent-codex` | `.scratch/claude-in-dsh`（`src/{host,client}.dynamic.js`） |
| 技能 | `dsh-dev-skill` + 本文件 | `cordis-plugin-development`（查询 Provider → define → run → 读诊断修 Package） |

**建议**：T0 用动态插件把「SDK 可启动 + `system/init` 到达 + `sessionId` 预设是否被接受 + 审批回调是否触发」四条事实在真实运行例上钉死（避免静态包的 build/install 循环开销）；事实成立后再按 T1 起静态包。**动态插件不是交付物**——它不满足规则 §1 的双形态与 S2 的 roster 要求。动态插件期的 client 面若要做，须先 `Slots.listSubTree` 查真 Slot，宿主数据走 `harness.handle`/`host.call`（该技能的红线）。

---


## 10. 裁决记录（frontier 已清空，2026-09-16）

| # | 议题 | 裁决 | 来源 |
|---|---|---|---|
| R1 | V1 范围基线 | **B：能接的全接**（codex-parity + Claude 独有项） | user |
| R2 | 形态与端口 | 只管 **standalone**；hub 接入由上层另打包插件；端口取空闲（实测空闲 4985/4989/4990-4997，暂取 **4989**） | user |
| R3 | 认证与端点 | 继承原生端点；**copy 原生 `settings.json` + env keys** 进 app home（单向阀） | user |
| R4 | 独立 home 的代价 | 接受并登记（原生 `claude --resume` 看不到 adapter 会话） | user |
| R5 | 执行体 | **指宿主** `/home/u1/.local/bin/claude`（`pathToClaudeCodeExecutable`）；宿主 2.1.261 与载荷 2.1.263 两个版本都在 readiness 报告（诊断用） | user |
| R6 | 会话生命周期 | 照 omp-web：构造零 IO、首 prompt 物化、resume 只重挂不驱动轮次；idle TTL 默认 **600_000 ms**（`CLAUDE_IDLE_EXIT_MS`），fire 时多重静默复核 | user（「ref omp-web」） |
| R7 | 命名 | 包 `@pgmi-builds/agent-adapter-claude`；plugin id `aw.agent-adapter-claude-world`；roster key `claude` / label `Claude`；LLM route id **`claude`**（避开上游 subagent 的 `claude-code`）；home `$DSH_HOME/agents/claude`；profile `$DSH_HOME/profiles/claude` | user |
| R8 | Session id | **路线 A**：DSH id 的 UUID 段直接作 Claude session id（免映射表）；路线 B 仅作非法 id 兜底且**必须可观测** | user（且静态取证支持） |
| R9 | 审批 / 提问 / plan | 接 `ctx.approval` / `ctx.userQuestions.ask()`（plan 走 `plan-review` intent）——见 §6.5 | user（「wire up to native dsh interface, closest one」） |
| R10 | 权限档 | 3 档骨架（`read-only`/`workspace-write`/`danger-full-access`）+ `plan`/`auto`/`dontAsk` 附加档；`setPermissionMode` 运行中可切 | user |
| R11 | steer / 排队 / 停止 | `agent.steer` / `agent.followup` / `agent.cancel({kind:'user'},{keepInbox:true})` | user |
| R12 | slash 命令 | 列进 DSH 命令面（`ctx.commands.register`）**并可本地执行**（注入命令文本 → CLI 绕过 query loop → `local_command_output`） | user |
| R13 | dialogKind | **V1 不声明、不接线**（`supportedDialogKinds`/`onUserDialog` 都不给，见 §6.5）；`refusal_fallback_prompt` 归 T0 取证 | user 推翻本研究早前建议 |
| R14 | 图片 | DSH 贴图是原生 UI；adapter 负责 DSH image/file block → Anthropic `ImageBlockParam` | 本研究 |

### T0 取证项（进计划的第 1 条任务）

1. `query({options:{sessionId:<DSH 派生 uuidv7>}})` 被接受，且 `system/init.session_id` 回读一致（不通过则退路线 B）。
2. `pathToClaudeCodeExecutable` 指宿主二进制能起并返回 `system/init`（同时记录宿主与载荷两版本）。
3. 抓一次真实 `refusal_fallback_prompt` 的 `dialogKind` `payload` 形状——**仅为将来声明取证，V1 不声明**。


---

## 附：证据索引（本文所有断言的来源）

- SDK 类型声明：`upstream/deepseek-harness/packages/subagent/subagent-claude-code/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`（`query` :2953；`Query` :2601；`Options` :1396；`SDKMessage` :4681；会话 API :568/:738/:767/:797/:834/:992/:1047；`ModelInfo` :1266；`ModelUsage` :1307；`CanUseTool` :209；`HOOK_EVENTS` :854；`SessionStore` :5601；`SDKSessionInfo` :5059；`SessionId` option :1927）
- 上游同源实现：`…/subagent-claude-code/{README.md,src/index.ts,src/run.ts,src/process.ts,cordis.patch.yml}`（`src/run.ts:310-380` 为 `claudeQueryOptions`；`:370-376` 为 `spawnClaudeCodeProcess`）
- preset 行：`upstream/deepseek-harness/packages/preset/agent-presets/presets/standard/agent.cordis.yml:213-218`
- DSH session id 铸造：`upstream/deepseek-harness/packages/core/session/src/index.ts:965`
- DSH AgentFactory 契约：`upstream/deepseek-harness/packages/core/agent/src/index.ts:171-203`
- 同构先例：`apps/agent-worlds/agent-codex/{package.json,cordis.patch.yml,src/{index.ts,adapter.ts,agent.ts,codex-client.ts,codex-events.ts,session-map.ts,world-plugin.ts},scripts/setup-codex-home.mjs,test/verify-codex-app.mjs}`
- hub：`apps/agent-worlds/agent-hub/src/{spawn-world.ts,roster.ts,gateway.ts,selector.ts,rpc.ts}`；测试台 `apps/agent-worlds/test/{start-codex-app.sh,start-world-4998.sh,smoke.mjs}`；fixture `agent-hub/test/fixtures/aw-codex-world/cordis.patch.yml`
- 规则：`.scratch/aw-codex/docs/agent-adapter-dev-rules.md`（§1 形态、§2 测试、§3 接线域、§4 per-adapter 决策、§5 home 红线、§6 纪律、§8 捕获策略、§10 DSH-native 会话管理、§12 per-agent 定制权、§13 home/profile 布局）
- 对照实现：`.scratch/claude-in-dsh/{README.md,src/host.dynamic.js}`（argv :15-18、:1494-1513；broker :1043 起）
- 本机实测：`claude --version` = 2.1.261；`~/.claude/` 布局与 `settings.json` env 段；`CLAUDE_CONFIG_DIR` 二进制字符串证据
- 本地静态取证（2026-09-16 子代理，零 API 调用，记录于 `/tmp/cc-sdk-facts.md`）：session-id 谓词 = 通用 UUID 正则 + `/i`（SDK/CLI 逐字一致，v7 接受；`Invalid UUID version:` 等串属 Zod v4 `$ZodUUID` / `@azure/msal-node`，**与 session-id 无关**）；平台载荷路径与可执行性；`CLAUDE_CONFIG_DIR` 下 `.credentials.json` / `.claude.json` / `settings.json` 的解析
