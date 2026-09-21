# agent-codex 开发计划（v1：B 线主案）

- **日期**: 2026-09-10
- **定位**: `@pgmi-builds/agent-codex`（Codex foreign-runtime adapter，CTX 独占形态）开发计划草案
- **裁决（2026-09-10 user，两次收敛）**: **先做模式 B——直接接入 GUI 同款后端（codex app-server JSON-RPC over 共享 `~/.codex` home）**，认证/API key 复用现场已有（本机 cc-switch glm-5.2，auth=apikey 实测通过）；桥接层按**最广面大全集**开发。`@openai/codex-sdk` 降级为后续 fallback（B 面的子集，多模式 adapter 的第二实现）。
- **蓝本**: `apps/multi-agent-ctx/agent-omp/`（同目录姊妹包，已全链路验收的结构照抄）
- **上游语境**: `docs/superpowers/plans/2026-09-10-multi-context-design.md` + `docs/adr/0008-multi-context-process-model.md`

---

## 一、本机 Codex 实测事实（2026-09-10 核验）

### CLI

- 二进制 `~/.local/bin/codex`，`codex-cli 0.153.4`（npm `@openai/codex` 装出的 launcher，自带 pin 的 rust 运行时；`~/.cache/codex-runtimes/codex-primary-runtime`）。
- 关键子命令：`exec`（非交互）、`resume`/`fork`/`queue`/`archive`/`delete`、`app-server`（**experimental** JSON-RPC 2.0，stdio/ws/unix socket，含 `daemon`/`proxy`/`generate-ts`/`generate-json-schema`）、`mcp-server`（stdio，已弃方向）、`exec-server`（pty）。
- **无 ACP**（源码级事实，2026-09-05 调研已核）。

### 认证与模型（本机现状）

- `~/.codex/auth.json` 存在（ChatGPT 登录态，GUI 共用）；`config.toml` 当前是 **custom provider 形态**：`model_provider = "custom"`、`model = "glm-5.2"`、`model_catalog_json = "cc-switch-model-catalog.json"`（cc-switch 管理的多 provider 目录）。即本机 Codex 走 cc-switch 网关而非官方 OpenAI 后端——这对 adapter 是利好：模型目录/默认模型有现成 TOML 面可读。
- `~/.codex/sessions/YYYY/MM/DD/*.jsonl` = rollout 持久层（SDK 线与 GUI 共用同一棵会话树）。
- `~/.codex/ipc/ipc.sock` = GUI 共享 app-server daemon 的控制 socket。

### GUI app

- 本机 "codex gui app" = **ChatGPT 桌面应用**（`/usr/share/applications/chatgpt.desktop`，注册 `x-scheme-handler/codex`）。它与 CLI 共享：`~/.codex`（config/auth/sessions）、app-server daemon（`codex agents` 即浏览该 daemon 的会话）、`config.toml [desktop]` 段（followUpQueueMode=steer、conversationDetailMode=STEPS_PROSE 等）。
- **对本计划的含义**：GUI 与 SDK 线是同一持久层的两个客户端。adapter 用 SDK spawn 的 codex 进程写的 rollout，GUI 事后可见；反之亦然。三方避让问题与 agent-omp 的「SDK/TUI/bridge 三方」同构（omp README「会话所有权对齐」一节直接平移）。

### GUI 与 CLI 关系实证：同核双壳（2026-09-10，回应用户关键问题）

**结论：Codex GUI 和 CLI 不是同一个 App 套壳，也不是两个无关 App，而是「同一个 codex 内核（app-server）、两份独立分发的壳」，通过共享 `~/.codex` home + loopback unix socket 上的 app-server daemon 协同。**

实证链（本机）：

- **GUI 壳** = ChatGPT Electron 应用（`/usr/lib/chatgpt/ChatGPT`；`codex-launcher` 只是转发脚本）。它**自带一份 codex rust 二进制**：`/usr/lib/chatgpt/resources/codex`（ELF static-pie，实测 `codex-cli 0.153.4`），另有 `codex-code-mode-host` 与 `~/.cache/codex-runtimes/codex-primary-runtime`（plugins/依赖包，runtime.json bundleVersion 26.904.11930，packagedFrom `codex-apps/electron` 流水线）。
- **CLI 壳** = npm `@openai/codex` launcher（`~/.local/bin/codex`，node 脚本）spawn 自己 vendored 的另一份二进制（`…/@openai/codex-linux-x64/vendor/…/bin/codex`），同样 0.153.4。**两份二进制互不调用、各自随自己的渠道升级**（当前碰巧同版）。
- **协同面 = 共享 home + loopback unix socket**：`~/.codex/app-server-control/app-server-control.sock`（daemon 控制）、`~/.codex/ipc/ipc.sock`（GUI↔daemon 活连接，`ss -x` 实测多对 ESTAB）；`config.toml [desktop]` 段（followUpQueueMode=steer 等）是 GUI 专属配置写在共享 config 里。
- **CLI 官方支持消费 GUI 的 daemon**：`codex agents` 自述 "Browse all agent sessions on the shared local app-server daemon"（`--remote unix://PATH`/`ws://host:port`）；`codex app-server proxy --sock <path>` 把 stdio 字节流代理到任意 daemon socket —— 第三方接入 daemon 的官方通道。daemon 生命周期管理在 `codex app-server daemon start/stop/version`。

**Adapter 数量裁决：一个 `agent-codex` 足够，不需要 Agent-Codex-CLI + Agent-Codex-GUI 两个 adapter。** 理由：GUI 的引擎就是 codex app-server（与 CLI/SDK 同一内核、同一持久层 `~/.codex/sessions`）——「衔接 Codex GUI」不是衔接另一个 runtime，而是选择**是否接入 GUI 正在用的那个 daemon**。据此把集成形态从单一「SDK spawn」升级为**双模式**：

| 模式 | 通道 | 得到 | 代价/风险 |
|---|---|---|---|
| **A. SDK spawn（v0 原案，V1 默认）** | `@openai/codex-sdk` spawn 独立 codex 进程 | 完全隔离、生命周期自管、版本随我们 exact-pin | 无 steer/审批应答/live setModel；与 GUI 只共享文件层（事后可见，非同场） |
| **B. daemon-attach（深度衔接线，Codex 用户红利）** | 连 `~/.codex/ipc/ipc.sock`（或经 `app-server proxy --sock` stdio 化）/ `app-server daemon start` 自管 daemon | **与 GUI 同场**：GUI 正在跑的会话在我们 UI 实时可见可续；steer / 审批卡 / interrupt / 全量 session list（GUI 自己消费的同一条协议，`generate-ts` 有官方 TS 绑定） | 协议 experimental 且随 GUI 捆绑二进制漂移（对齐轮需盯 `app-server daemon version` 双侧）；介入用户 GUI 活动需避让；ToS 边界（借用 GUI 订阅登录态 vs A 档 API key 独立认证） |

双模式共用同一 `CodexThreadClient` 接缝与全部衔接层（store/replay/preset/permission 不感知通道）——mode 是 client 实现的选择。V1 落 A；B 列为 P6 深度衔接线（§三）。GUI 专属数据（[desktop] 配置、computer-use 插件、codex-runtimes 插件生态）在 B 线里顺带可达，不单独立 adapter。

### GUI 与 CLI 关系实证：同核双壳（2026-09-10，回应用户关键问题）

**结论：Codex GUI 和 CLI 不是同一个 App 套壳，也不是两个无关 App，而是「同一个 codex 内核（app-server）、两份独立分发的壳」，通过共享 `~/.codex` home + loopback unix socket 上的 app-server daemon 协同。**

实证链（本机）：

- **GUI 壳** = ChatGPT Electron 应用（`/usr/lib/chatgpt/ChatGPT`；`codex-launcher` 只是转发脚本）。它**自带一份 codex rust 二进制**：`/usr/lib/chatgpt/resources/codex`（ELF static-pie，实测 `codex-cli 0.153.4`），另有 `codex-code-mode-host` 与 `~/.cache/codex-runtimes/codex-primary-runtime`（plugins/依赖包，runtime.json bundleVersion 26.904.11930，packagedFrom `codex-apps/electron` 流水线）。
- **CLI 壳** = npm `@openai/codex` launcher（`~/.local/bin/codex`，node 脚本）spawn 自己 vendored 的另一份二进制（`…/@openai/codex-linux-x64/vendor/…/bin/codex`），同样 0.153.4。**两份二进制互不调用、各自随自己的渠道升级**（当前碰巧同版）。
- **协同面 = 共享 home + loopback unix socket**：`~/.codex/app-server-control/app-server-control.sock`（daemon 控制）、`~/.codex/ipc/ipc.sock`（GUI↔daemon 活连接，`ss -x` 实测多对 ESTAB）；`config.toml [desktop]` 段（followUpQueueMode=steer 等）是 GUI 专属配置写在共享 config 里。
- **CLI 官方支持消费 GUI 的 daemon**：`codex agents` 自述 "Browse all agent sessions on the shared local app-server daemon"（`--remote unix://PATH`/`ws://host:port`）；`codex app-server proxy --sock <path>` 把 stdio 字节流代理到任意 daemon socket —— 第三方接入 daemon 的官方通道。daemon 生命周期管理在 `codex app-server daemon start/stop/version`。

**Adapter 数量裁决：一个 `agent-codex` 足够，不需要 Agent-Codex-CLI + Agent-Codex-GUI 两个 adapter。** 理由：GUI 的引擎就是 codex app-server（与 CLI/SDK 同一内核、同一持久层 `~/.codex/sessions`）——「衔接 Codex GUI」不是衔接另一个 runtime，而是选择**是否接入 GUI 正在用的那个 daemon**。据此把集成形态从单一「SDK spawn」升级为**双模式**：

| 模式 | 通道 | 得到 | 代价/风险 |
|---|---|---|---|
| **A. SDK spawn（v0 原案，V1 默认）** | `@openai/codex-sdk` spawn 独立 codex 进程 | 完全隔离、生命周期自管、版本随我们 exact-pin | 无 steer/审批应答/live setModel；与 GUI 只共享文件层（事后可见，非同场） |
| **B. daemon-attach（深度衔接线，Codex 用户红利）** | 连 `~/.codex/ipc/ipc.sock`（或经 `app-server proxy --sock` stdio 化） / `app-server daemon start` 自管 daemon | **与 GUI 同场**：GUI 正在跑的会话在我们 UI 实时可见可续；steer / 审批卡 / interrupt / 全量 session list（GUI 自己消费的同一条协议，`generate-ts` 有官方 TS 绑定） | 协议 experimental 且随 GUI 捆绑二进制漂移（对齐轮需盯 `app-server daemon version` 双侧）；介入用户 GUI 活动需避让；ToS 边界（借用 GUI 订阅登录态 vs A 档 API key 独立认证） |

双模式共用同一 `CodexThreadClient` 接缝与全部衔接层（store/replay/preset/permission 不感知通道）——mode 是 client 实现的选择。V1 落 A；B 列为 P6 深度衔接线（§三）。GUI 专属数据（[desktop] 配置、computer-use 插件、codex-runtimes 插件生态）在 B 线里顺带可达，不单独立 adapter。

### SDK（`@openai/codex-sdk`，registry 版本 0.153.4 = CLI 版本，exact-pin 前提成立）

TS SDK，纯 Node（≥18），spawn `codex` CLI 子进程、stdin/stdout 交换 JSONL 事件。核心面：

- `new Codex({ apiKey?, baseUrl?, env?, config?, configOverrides?, cwd? })`；`baseUrl` → `--config openai_base_url`；`env` 可整体接管子进程环境（含 `CODEX_HOME`）。
- `codex.startThread(opts)` / `codex.resumeThread(threadId)`；`thread.id`（turn 开始后填充）。
- `thread.run(input)` → `{ items, finalResponse, usage }`；`thread.runStreamed(input)` → async generator（`item.completed` / `turn.completed` / `turn.failed` 等结构化事件）——这是事件流桥接的主通道。
- Thread/Turn options：`model`、`sandboxMode`（read_only / workspace_write / full_access）、`approvalPolicy`、`workingDirectory`、`skipGitRepoCheck`、`modelReasoningEffort`、`additionalDirectories`、`webSearchMode`、`signal`（turn 级 AbortSignal）。
- 输入支持文本+images；`outputSchema` 结构化输出。
- 会话持久化在 `~/.codex/sessions`，进程重启后 `resumeThread` 续接。

**SDK 面 vs omp A/S 清单的已知缺口**（P0 spike 需逐一核实）：

| 能力 | omp 对应 | codex SDK 现状 |
|---|---|---|
| 中断 | `abort()` | `signal`（AbortSignal，turn 级）；无显式 interrupt API |
| steer / followUp | `steer`/`followUp` | 无一等 API；GUI 的 steer 走 app-server daemon 面。**预置结论：SDK 线 V1 不做 steer**，queued-follow-up 用「turn 完成后立即 run」近似 |
| 会话列表 | `SessionManager.listAll` | TS SDK 未见 listThreads 一等面 → 直接索引 `~/.codex/sessions` JSONL（omp P4 的自研解析线平移；或 `codex app-server` 面升级） |
| 审批应答 | approval 事件 + autoApprove | approvalPolicy preset（agent-omp 同款 launch-only 语义） |
| messages 手术 / compact | `state.messages`/`compact` | 无；V1 不做 |
| system prompt 读写 | `session.systemPrompt` | 无（instructions 走 config 覆盖）；V1 只读投影或跳过 |
| 模型/设置读写 | ModelRegistry/Settings | 读 `config.toml` + `model_catalog_json`；写留 V2 |

---

## 二、架构设计（对齐 multi-agent-ctx 四不变量）

### 集成形态（v1）：**app-server 直连（B 线主案），进程内 Node client，无 sidecar**

2026-09-10 实测定案：spawn `codex app-server`（stdio、newline-delimited JSON、wire 上省略 `jsonrpc` 头），共享 `~/.codex` home → 自动继承现场认证（本机 auth=apikey + cc-switch custom provider glm-5.2）与 GUI/CLI/VSCode 的全部历史会话。协议绑定用 `codex app-server generate-ts --experimental` 官方产物（已导出到 `.scratch/codex-proto/ts/`，100+ 文件，v1/v2 双版本面）。全链路真 turn 已跑通（见 §三 P0 as-built）。

```
CTX_codex (web profile 形态 + adapter 行，webserver 绑专属 loopback 端口)
  └─ @pgmi-builds/agent-codex（cordis 插件）
       ├─ CodexProvider → AgentFactory（createAgent/resume → thread/start|resume 事务）
       ├─ CodexAppServerClient（JSON-RPC over stdio：initialize/thread/turn/model/config/account）
       ├─ CodexAgent（Session/AgentHandle 契约：prompt/steer/interrupt/get_messages/set_model…）
       ├─ CodexLlmAdapter（model/list + config/read → ctx.llm 目录）
       ├─ bridge-store（SQLite 索引 = list/id 权威；rollout JSONL = transcript of record）
       ├─ SingleCodexPresetRoster + agent-preset projection（照抄 P1/P1.1）
       └─ replay / session-persistence-codex / content-detection（照抄移植）
```

**会话并发模型（2026-09-10 user 裁决：不做避让）**：GUI/CLI/VSCode/我们四方都是 `~/.codex` 上的普通消费端；同一 thread 两端同时 prompt = 原生 session handler 内短时两个 prompt-in，服务器端不报错，消费端至多看到"多出一条不是我发的"——Codex 原生多消费端设计（GUI↔mobile、ipc follower 协议）本就覆盖此场景。bridge 直接按可消费面消费，不搞 writer-pid 避让。

不变量核对：

1. **UI 数据面纯净性**：selector=codex → CTX_codex 自有 remote service 纯净投影；无 union listing。
2. **导流统一 remote service 层**：adapter 自己决定暴露哪些服务。
3. **完整 web 面形态**：web profile + cordis.patch.yml（bundle patch 平移 agent-omp 版：mount codex-provider，disable agent-loop/llm-deepseek/llm-pi-ai/agent-presets/session-persistence-jsonl，permission 3-preset 表 + defaultPreset 映射 codex sandboxMode）。
4. **不走 `runProfile()`**；`CODEX_HOME` 裁决为**共享 `~/.codex`**（B 线前提：认证、会话树、GUI 互见都在共享 home 上；§六.1 关闭）。

### 包结构（目标）

```
apps/multi-agent-ctx/agent-codex/
  package.json        @pgmi-builds/agent-codex@0.0.1-ctx
                     deps: @openai/codex-sdk@0.153.4 (exact), @openai/codex@0.153.4 (exact，提供二进制)
  cordis.patch.yml    bundle patch（上述）
  src/                从 agent-omp 逐文件移植：index/agent/adapter/replay/store/
                     session-persistence-codex/supervisor/pairing/permission/
                     agent-preset-codex/agent-preset-projection/knobs
  src/codex-client.ts 与 OmpSdkClient 同公共面的 CodexThreadClient
  src/codex-store.ts  ~/.codex/sessions rollout 索引（omp-store 平移）
  types/@deepseek-ai  桩（同惯例）
  test/               content-detection/store/replay 单测 + sdk-client 集成 + 冒烟
```

**关键映射表**（omp 语义 → codex 语义）：

| omp | codex | 备注 |
|---|---|---|
| `OmpSdkClient.prompt` | `thread.runStreamed` | 事件流→SessionEvent 投影 |
| `OmpSdkClient.abort` | AbortController.abort() | turn 级；abort 后 thread 仍可续 |
| `OmpSdkClient.newSession/--resume` | `startThread`/`resumeThread` | thread.id ↔ Dash session 转发表 |
| `OmpSdkClient.setModel` | 下一 turn `model` option（或 config 覆盖重启 thread） | codex 无 live setModel；turn 级传参 |
| `--approval-mode` | `approvalPolicy` + `sandboxMode` thread options | permission preset 3:3 映射 |
| `SessionManager.listAll` | 自研 rollout JSONL 索引 | P4 平移 |
| `settings.modelRoles` | `config.toml` 读 + 写留 V2 | cc-switch catalog 投影 |

### 与 GUI/app-server 的边界

- **不碰共享 daemon**（`~/.codex/ipc/ipc.sock`）：SDK spawn 独立 codex 进程，与 daemon 并行、共享文件层。避免与 GUI 会话互踩进程面。
- **SDK 的再定位**：SDK 线 = B 面的子集 fallback（spawn 独立进程、隔离性好，适合无 GUI/daemon 场景）。`CodexThreadClient` 接缝下 mode 是实现选择，B 全量面先行，SDK 后补为降级模式。

---

## 三、里程碑（TDD bite-size，每任务独立可测 + commit）

> 进度（2026-09-10）：P0 ✅ · P1-a ✅ · P1-b ✅ · **P2 ✅（子代理移植+核验）**：omp 桥接层全量落位 4624 行（agent/index/shared-client/store/persistence/supervisor[避让已裁]/permission/models/adapter/preset/pairing/knobs/codex-store/replay），tsc 0 错、2/2 集成测试绿。P3/P4 的 preset/permission/llm/会话列表面已随移植提前覆盖，待 4999 实测。**待核**：审批应答 `{decision}` 载荷形状。下一步：P5 4999 全链路验收（test profile + systemd-run + GUI 同场验证）。

### P0 — app-server 协议 spike（2026-09-10 已完成 ✅ PASS）

- **协议资产**：`codex app-server generate-ts --experimental --out` → 100 文件 TS 绑定 + JSON Schema（`.scratch/codex-proto/`）。客户端请求面 160+ 方法（v1+v2）：thread/start|resume|fork|list|read|items/list|inject_items|rollback|revert、turn/start|steer|interrupt|settings/update、model/list、config/read|value/write|batchWrite、account/read|usage、permissionProfile/list、fs/*、process/*、mcpServer/*、plugin/*、project/*、review/start 等；通知面 60+（item/started|completed、item/agentMessage/delta、reasoning/*、turn/started|completed、thread/status|tokenUsage|queue/changed、审批 ServerRequest 家族）。
- **传输事实**：stdio = newline-delimited JSON，**wire 上省略 `jsonrpc:"2.0"` 头**；unix socket 传输 = UDS 上的 WebSocket（HTTP Upgrade，`ws://localhost/rpc`）。
- **真机全链路**（`probe-appserver.mjs`，共享 home，glm-5.2）：initialize → getAuthStatus(apikey) → model/list(glm-5.2 + 4 reasoning efforts) → thread/list（**GUI/VSCode/CLI 会话全部可见**，含 cwd/source/status/path）→ permissionProfile/list(`:read-only`/`:workspace`/`:danger-full-access`) → config/read → thread/start → turn/start → 事件流（item/started|completed、agentMessage/delta 流式、tokenUsage、thread status idle↔active、turn/completed）→ thread/items/list 回读。**3.0s 全程**。
- **坑已记**：turn input 用 `{type:"text"}`（非 `input_text`）；thread/start 返回 `{thread:{id}}`；`~/.codex` 写入需真实文件系统（沙箱 EROFS，须 danger-full-access）；stderr PATH-aliases 警告无害。
- **两平面辨析**：`ipc.sock` ≠ app-server。它是 desktop IPC router（u32 LE 长度前缀 JSON 帧、initialize→clientId 握手、thread-owner-discovery / thread-follower-* 词汇在 GUI 的 Electron 层）——是 GUI 各窗口/插件间的联邦总线，可选的 P7 同场增强，不是 B 线本体。

### P1 — CodexAppServerClient + provider 最小面
1. `app-server-client.ts`：spawn/生命周期/JSONL 帧编解码/请求-事件分发/优雅关停（含 EPIPE 加固，omp P3.1 教训：stdin error sink + writeSafe）；协议类型 vendored 自 generate-ts 产物。
2. `index.ts` provider：AgentFactory createAgent/resume（thread/start|resume）事务（prepare→setup→publish 照抄 omp）；threadId↔Dash sessionId 转发表；cordis.patch.yml（照抄 omp 版：mount codex-provider，disable agent-loop/llm-deepseek/llm-pi-ai/agent-presets/session-persistence-jsonl）。
3. prompt→turn/start、steer→turn/steer、abort→turn/interrupt、setModel→thread/settings/update 映射 + 事件→SessionEvent 投影（user/agentMessage/toolCall/reasoning delta）。

### P2 — 移植衔接层
4. replay / session-persistence / store(SQLite bridge-store) / pairing / content-detection 逐文件移植 + 单测绿（supervisor 的避让逻辑按裁决裁掉，保留游标/索引职能）。
5. 冷会话：thread/items/list + thread/turns/list 分页回读（服务端已有，无需自研 rollout 解析——omp P4 自研线在 B 线不需要，JSONL 解析仅留 fail-soft fallback）。

### P3 — preset / permission / llm 面
6. SingleCodexPresetRoster（恰一条 `codex`/`Codex`/isDefault）+ agent-preset projection（顶层 fiber 注册，omp P1.1 教训）。
7. permission 3-preset 表 → permissionProfile(`:read-only`/`:workspace`/`:danger-full-access`) + approvalPolicy 映射；审批 ServerRequest（execCommandApproval 等）→ Dash 审批卡（B 线一等能力，omp 遗留项在 B 线自然补齐）。
8. CodexLlmAdapter：model/list + config/read → modelCatalog（reasoning efforts → 档位）。

### P4 — 会话列表全量
9. thread/list 全量分页（GUI/CLI/VSCode 会话一体呈现，无避让、无命名空间标签——数据面纯净性由 selector 保证）；thread/search 备用。

### P5 — 4999 全链路验收
10. test profile `agent-codex-test`（systemd-run 惯例，DSH_HOME 仓内）拉起：auth 200 → session/create → prompt → session/page 回读全事件链。
11. 验收模式照仓根 AGENTS.md §三：token URL 交用户、保持运行等亲手测完再收尾；报告落 `docs/test-reports/`。GUI 侧同场验证：adapter 建的 thread 在 ChatGPT 桌面里可见可续（反之亦然）。

### P6 — SDK fallback 模式（B 面子集，后续开发）
12. `CodexThreadClient` 增加 SDK 实现（同公共面）：无 daemon/GUI 环境降级、`CODEX_HOME` 隔离场景；能力矩阵记档（steer/审批/live setModel 为 B 独有）。

### P7 —（可选）ipc.sock follower 同场线
13. desktop IPC router 接入（u32 LE 帧协议）：thread-owner-discovery / thread-follower-start-turn —— GUI 已打开的活会话实时同场（属 Electron 层私有协议，随 GUI 版本漂移，独立排期）。

---

## 四、风险与已见坑

- **EROFS/沙箱**：codex 要写 `~/.codex`（sessions/logs）；agent 沙箱内跑 spike/测试需对该目录写权限（omp sidecar 同款问题，danger-full-access 实测先例）。
- **PATH aliases warning**：本机 codex 启动报 "could not create PATH aliases: Read-only file system"——无害；app-server 走 stdout JSONL，stderr 已分离。
- **git repo 强制要求**：thread/start 带 cwd 即可（P0 实测在仓内 cwd 直接成功；非 git cwd 行为待 P1 核，必要时走 config 覆盖）。
- **多消费端并发（裁决：不做避让）**：GUI/CLI/VSCode/bridge 共享 `~/.codex`；同一 thread 并发 prompt 是原生场景（服务器端 session handler 自管），消费端至多看到多一条外部 prompt。bridge-store 只做索引权威、绝不回写 rollout。
- **ToS**：不得借用 GUI 的 ChatGPT 订阅登录态转售（2026-09-05 调研结论）；本机走 custom provider/API key 无此问题，但文档须写明。
- **版本漂移**：B 线依赖 app-server 协议（experimental 标记但已是 GUI/CLI 共同主干）；对齐轮加查 `codex app-server daemon version` 双侧（我们 spawn 的 CLI vs GUI 捆绑二进制），协议 break 时以 `generate-ts` diff 为准。

## 五、明确不做（V1 范围外）

- steer / followUp 注入（SDK 无面；turn 排队近似）。
- ~~steer / followUp 注入~~（B 线原生 `turn/steer` + `thread/queue/*`，已入 P1 范围）。
- realtime 语音线（`thread/realtime/*`）、fs/process 暴露面（属 Codex 自家 GUI 的系统服务，不映射 Dash 契约）。
- `codex mcp-server`、`codex cloud`、exec-server(pty) 面。
- mobile/独立 UI（UI 数据面纯净性：浏览器 UI 是 CTX0 native 的）。

## 六、开放问题

1. ~~CODEX_HOME 隔离 vs 共享~~ **已裁决共享 `~/.codex`**（B 线前提：认证/会话树/GUI 互见；P0 实测通过，多消费端并发不避让）。
2. setModel 语义：B 线用 `thread/settings/update`（thread 级持久，非 turn 级）——比 SDK 线强，P1 核实生效时机。
3. 审批卡：B 线有完整 ServerRequest 审批族（execCommandApproval/applyPatchApproval/permissionsRequestApproval）→ Dash 审批卡一等映射，P3 落地。

---

## 变更记录

- 2026-09-10 草案 v0：基于 agent-omp as-built、本机 codex CLI/GUI/SDK 实测、multi-context 蓝图起草。
- 2026-09-10 v1：user 裁决 B 线主案（app-server 直连、共享 home、大全集先行、不做避让、SDK 降级为 fallback）；P0 spike 完成（协议绑定导出 + 真 turn 全链路 PASS）。
