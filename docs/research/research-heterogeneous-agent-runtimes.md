# 异构 Agent 运行时 SDK 调研（基础研究）——"OMP 式 SDK 可 wrapper 性"测绘

> 日期：2026-09-05 · 性质：**基础研究**（为 A2A Communication Platform / Agent Orchestration / 单运行时 Web UI 等上层项目做前置测绘，暂不立项）
> 范围：OMP（oh-my-pi）、DSH（DeepSeek Harness）、Hermes Agent（Nous Research）、御三家——Anthropic Claude Code / OpenAI Codex / Google Antigravity（原 Gemini CLI）
> 本次只深挖 **Layer 5 SDK**（CLI / HTTP / RPC / ACP 各层此前已有实测与结论，见 §2，不再展开）
> 方法：本机安装版本取证（~/.local/bin 六家全在，是活的部署现场）+ web 2026-09-05 一手来源交叉核对
> 本档自包含，可独立复制到其他工作目录使用

---

## 0. TL;DR

1. **六家里四家有"官方 SDK"，但形态是四种不同物种**，没有一个与 OMP 的库级嵌入完全同构：
   - **OMP**＝库级嵌入（把核心 import 进你进程，`createAgentSession`）——基线；
   - **Claude Code / OpenAI Codex**＝**自带运行时 + 协议驱动**型 SDK（SDK 捆绑官方 core 二进制/运行时，每次起子进程用 stdio/JSON-RPC 驱动，非进程内库 import）；
   - **Google Antigravity**＝库级 Python SDK（`google-antigravity`，把 Antigravity Runtime 当库 import，wheel 内嵌 runtime 二进制）——最接近 OMP，但 2026-05 preview、仅官方 Python；
   - **Hermes（Nous）**＝**没有官方库级 SDK**：最接近的嵌入是源码 `import run_agent.AIAgent`（无受支持 wheel）+ serve 的 JSON-RPC/OpenAI 兼容 HTTP 协议面。
   - **DSH**＝平台方，没有"给外部 wrapper 的 SDK"概念——它自己就是被包/被 embed 的对象（其 open 面 = plugin patch 标准 + `packages/sdk` + ACP server/client）。
2. **按"OMP SDK 标准"（①wrapper 不破坏原生核心保真；②生产不破坏用户已装现场）分档**：OMP / Claude Code / Codex / Antigravity 落在 **A 档**（wrapper 自带引擎、可与用户全局安装完全隔离共存、保真≈原生）；**Hermes 无官方 SDK → B/C 档**（只能用协议桥或源码 import，且与用户共享 ~/.hermes 现场，需 profile 隔离）；DSH 不适用标尺、是中枢宿主候选。
3. **共性结论：四家 A 档 SDK 全部"自包含引擎 + 支持独立认证（API key）"**——即可以做到**不依赖、不触碰用户已装的 CLI 与其登录态**；差异只在"进程内库" vs "子进程协议驱动"（影响事件注入深度与进程模型，不影响功能保真与现场零破坏）。
4. **三家厂商（Claude/Codex/Antigravity）都明确禁止/限制"借用用户订阅登录态做产品转售"**——SDK 契约要求用独立 API key；这是 wrapper 产品的法律边界而非技术边界。
5. 对上层项目：做 Adapter 时**优先选 SDK 或厂商官方协议面（app-server / stream-json / serve RPC），ACP/CLI spawn 作回退**；Hermes 类无 SDK 运行时的接入复杂度与现场侵入度显著高于 A 档四家——这是选型时最该提前知道的成本差。

---

## 1. 目的、上层场景与判定标尺

### 1.1 直接目的

探讨各主流 Agent 运行时有没有像 OMP 这样提供官方 SDK（OMP 先例：`@oh-my-pi/pi-coding-agent` 的 `createAgentSession()`——把 agent 核心当库 import，同进程拿 session/事件/工具，运行期注入 Settings/ModelRegistry，见 `docs/research-omp-inprocess-module-map.md`、`docs/plans/omp-sdk-fidelity-analysis.md`）。

### 1.2 上层可构建物（故为"基础研究"）

| 上层项目 | 本调研喂给它的部分 |
|---|---|
| **A2A Communication Platform** | Adapter 选型：每个运行时该接 SDK / 官方协议面 / ACP / CLI 哪一层；哪些能自包含、哪些必然触碰用户现场 |
| **Agent Orchestration Platform**（Multica 式） | 谁可被库级嵌入同进程、谁只能子进程外包、事件/注入面深浅——调度与隔离模型依据 |
| **单运行时加 Web UI**（OMP Web 式） | 有没有 `createAgentSession` 那样的 embedding 面，决定 Web 网关是 "SDK sidecar" 还是 "协议桥" |

### 1.3 判定标尺：OMP SDK 标准（两条验收线）

1. **保真**：用 SDK 做 wrapper，不破坏原生 Agent 核心的 functionality（行为继承 ≈100%，wrapper 只换前端呈现/加策略）；
2. **现场零破坏**：生产环境不对 user 已安装的该运行时造成破坏（可独立装/升级/锁版本，不依赖用户现场，不污染其 config/登录态/数据面）。

### 1.4 SDK 形态光谱（比"有无 SDK"更重要的新轴）

```
型 1  库级嵌入（in-process import）        —— OMP、Antigravity（官方 Python）
型 2  自带运行时 + 协议驱动（bundle core，spawn 子进程走官方私有协议）
                                          —— Claude Code（stdio 消息）、Codex（app-server JSON-RPC）
型 3  复用用户已装 CLI（spawn 用户 binary）—— 各家 CLI 都行，但不是 SDK；保真 100% 但引擎归属在用户侧
型 4  远程托管 API（云 agent，非本地核心） —— Codex Cloud/Responses、Antigravity Interactions、Claude Managed Agents
型 5  无官方 SDK（源码 import / 协议桥兜底）—— Hermes
型 6  平台方（被 embed 的对象）            —— DSH
```

---

## 2. 前序记录与边界（非本次范围）

- **ACP / CLI / HTTP / RPC 四层已有结论**，本次不再调研：本仓 `docs/plans/dsh-omp-provider.md` 有 OMP `acp` vs `--mode rpc` 的 2025 实测（ACP 扁平事件流 vs RPC 自带 turn/message/tool 边界，结论 RPC 优先）；`docs/upstream-dsh-0.1.2-alpha.5-report.md` 记录了 dsh 的 headless/full SDK/ACP 产品面；`docs/research-pty-tui-bridge.md` 覆盖 CLI/PTY 包装层。本次只补 **SDK 深挖**。
- 本机 ACP server 事实（背景一句）：`omp acp`、`hermes acp`、dsh `--profile acp`、`claude-agent-acp`/`claude-code-acp`（SDK 包装）均在——ACP 生态盘点另见社区资料，不在本档展开。

---

## 3. 逐运行时 SDK 测绘

版本锚点均为 2026-09-05 本机/registry 实证。

### 3.1 OMP（oh-my-pi）—— 基线样本（型 1）

> 前序细节：`docs/research-omp-inprocess-module-map.md`（模块/引擎取证）、`docs/plans/omp-sdk-fidelity-analysis.md`（保真度）、`docs/plans/omp-shipment-engine-ownership.md`（出货/引擎归属）。此处只列 SDK 测绘行。

| 维度 | 结论 |
|---|---|
| SDK | **官方一等**：`@oh-my-pi/pi-coding-agent`（npm 18.1.10；TS 源码分发，engines `bun>=1.3.14`） |
| 架构 | **型 1 库级嵌入**：Bun 进程内 `import { createAgentSession }`——核心（Pi Agent）就在你的进程里；TUI 只是另一个 mode |
| 注入/订阅 | `createAgentSession(options)`：`session.subscribe`（含 retry/auto_retry/model_changed/thinking 事件）、`prompt/steer/followUp/abort/sendCustomMessage/dispose`；运行期 `Settings.isolated()` 覆盖 fallbackChains、ModelRegistry 按 role 驱动——RPC 面给不了的运行期注入它都有 |
| 认证/配置 | 数据面 ~/.omp（config/auth/JSONL 会话）可与原生 TUI 共享或隔离 |
| 保真 | ≈100%（同一核心同一包；前端呈现是我们唯一要写的） |
| 现场零破坏 | 引擎随我们 bundle（Bun 编译/依赖锁版本）；不依赖用户自装 `omp` binary；双版本共存读写同一 JSONL 是显式待验项（对齐轮） |
| 判档 | **A（基线满分）** |

### 3.2 Anthropic Claude Code（型 2，A-）—— 官方 Agent SDK

| 维度 | 结论 |
|---|---|
| 身份锚点 | CLI v2.1.261（npm 最新 2026-09-04）；**2026-04 起自包含原生二进制**（native binaries 取代 bundled JS；npm 只是分发渠道，运行期不需 Node）；本地装 v2.1.250 |
| SDK | TS **`@anthropic-ai/claude-agent-sdk`**（0.3.261）/ Python **`claude-agent-sdk`**（PyPI 0.2.152）。**2026-06 更名**：旧 `@anthropic-ai/claude-code`（现只剩 CLI）与 PyPI `claude-code-sdk`（冻结 0.0.25）不再含 SDK——装错包/import 错是高频坑 |
| 架构 | **型 2**：SDK 经 per-platform optionalDependencies（`@anthropic-ai/claude-agent-sdk-linux-x64` 等）**自带 core 二进制**，无需用户另装 claude CLI（Python 侧可 `cli_path=` 指定）；每次 `query()` **spawn 一个 `claude` 子进程**、stdio 消息协议驱动、盘上落 `~/.claude/projects/` JSONL——**不是** oh-my-pi 那种同进程 import |
| 注入/订阅 | options：env、`systemPrompt`（v0.1.0 起默认最小 prompt，`claude_code` preset 需显式 opt-in）、`settingSources`、cwd；事件流（assistant / tool_use / result / system init / rate_limit / cost）；hooks（程序化 + 文件系统）；subagents、sessions（continue/resume/fork）、SessionStore、OTEL、structured outputs、plugins |
| 认证隔离 | 读宿主 env（`ANTHROPIC_API_KEY` 等）；想**完全不碰用户 ~/.claude** 需 `CLAUDE_CONFIG_DIR` 私有目录 + `settingSources:[]` + `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` + 干净文件系统（注意 settingSources:[] 仍会读 ~/.claude.json 与 managed 策略） |
| 锁版/部署 | SDK 捆绑 core 版本（0.3.261 ↔ core 2.1.261），随我们 bundle 即锁；与用户全局 claude 共存互不干扰；**授权条款**：第三方产品不得自称 "Claude Code"、不得替用户提供 claude.ai 登录/配额（须 API key） |
| 保真/缺口 | 跑的就是官方原生核心，工具/agent loop/上下文一致；非 100% 对齐：agent teams 等 CLI 专属面未全暴露、默认 system prompt 已剥离（需 preset 补）、部分 hooks/API 仅 TS 有 |
| 判档 | **A-（自包含、可全隔离；扣分 = 非库级 import、0.x 快发漂移、双线版本）** |

### 3.3 OpenAI Codex（型 2，A-）—— 官方 Py/TS SDK

| 维度 | 结论 |
|---|---|
| 身份锚点 | CLI `codex-cli` 0.153.4（2026-09-04，近似日更；本地装 0.142.3）；npm `@openai/codex` 只是 **13KB launcher**（按平台拉 `@openai/codex-<os>-<arch>` optional 依赖里的二进制），非 SDK；Rust 实现（`codex-rs/cli`） |
| SDK | TS **`@openai/codex-sdk`**（npm 0.153.4，与 CLI 同版同节奏）/ Python **`openai-codex`**（PyPI 0.144.4，**独立版本线**，与 CLI/TS 不同步）。crates.io **无 `codex-rs`**（Rust 库级嵌入官方不支持，只能 git 依赖自构建） |
| 架构 | **型 2**：Py `Codex()` 底层 `subprocess` 拉起 **`codex app-server --listen stdio://`** 走私有 JSON-RPC（仿 MCP 的 JSON-RPC 2.0；stdio 默认，可 `ws://`/`unix://`，VS Code 官方插件即其客户端）；`CodexConfig` 可指 `codex_bin` 任意二进制、`config_overrides`、`env`。SDK 定位官方原话 = "programmatically control **local** Codex agents" |
| 注入/订阅 | `thread_start(model, sandbox)`、`turn/run` 结构化结果 + **流式事件订阅**（async、turn abort/controls）；`startThread/resumeThread(threadId)`；sandbox 预设 read_only/workspace_write/full_access；approval_mode 映射；config/profile 注入 |
| 认证隔离 | 默认复用 `~/.codex` 登录态（文档明示 "reuses your existing Codex authentication"）；隔离靠 **API key 登录 + `CODEX_HOME` / 自定义 env / `codex_bin`** 指向独立二进制 |
| 锁版/部署 | Py SDK 依赖自带 wheel `openai-codex-cli-bin==<版本>`（内嵌二进制）；TS SDK 依赖 `@openai/codex@<精确版>` 自带 launcher+平台包——**均不触碰用户全局 codex** |
| 保真/缺口 | 覆盖原生 harness（本地线程/多轮/流事件/审批/sandbox/模型/登录）；经 app-server JSON-RPC **间接层**而非进程内库 import；自研工具/自定义安全策略只能在 harness 外或 hooks/permissions 层，不可直接换 core |
| 坑 | `codex mcp-server` 官方已标 deprecated（新集成被引向 app-server/SDK）；多产物多版本线（CLI 0.153.4 / Py 0.144.4）务必精确锁；`app-server`/`remote-control`/`exec-server` 仍 experimental；第三方 ACP 会话与官方桌面端状态不同步（not_planned） |
| 判档 | **A-（自带 pin 运行时、零侵入；扣分 = 间接层协议契约随日更漂移、多版本线、无 Rust 库级面）** |

### 3.4 Google Antigravity / agy（原 Gemini CLI）（型 1，A，preview 减分）

| 维度 | 结论 |
|---|---|
| 身份锚点 | **2026-05-19（I/O）Gemini CLI → Antigravity CLI（`agy`）**；2026-06-18 起停服个人账号（免费/Pro/Ultra）；CLI 从 TS/Node 改为 **Go 原生二进制**，与桌面 App（本机 /opt/Antigravity-x64 Electron）共用同一 agent harness；旧 `google-gemini/gemini-cli` 仓与 npm `@google/gemini-cli` 0.58.0 **仍在维护**（服务企业/API key 路径）。agy 首装自动迁移 `~/.gemini`（Skills/MCP/Agents） |
| SDK | 官方 **Python `google-antigravity`**（Apache-2.0，2026-04-29 建仓，2026-05 preview；repo ~3.2k★）。TS/Go/Java 无官方（社区移植 antigravity-sdk-ts/agy-sdk-ts） |
| 架构 | **型 1 库级嵌入（官方 Python）**：`Agent` + `LocalAgentConfig` 把 **Antigravity Runtime（与 CLI/桌面 2.0 同一 harness）当库 import**；**wheel 内嵌编译 runtime 二进制**。另有 **Interactions API**（`POST generativelanguage.googleapis.com/v1beta/interactions`，`agent="antigravity-preview-…"`）＝型 4 远程托管 agent（自带 Linux 沙箱） |
| 注入/订阅 | 内置工具集、hooks、策略引擎、MCP server 接入、sub-agent、会话持久化、结构化输出、流式 |
| 认证 | `GEMINI_API_KEY`（需 settings.json `modelProvider:"gemini"`）或 Google 账号 OAuth 或 GEAP/Vertex(ADC) |
| 现场零破坏 | Go 单二进制、不碰 Node 环境；installer 可 `--skip-alias/--skip-path`；但仍读写 `~/.gemini`、首次需浏览器或 API key 认证 |
| 保真/缺口 | 库级 = 同 harness 保真最高；但 **2026-05 preview、演进中**；官方仅 Python；无原生 ACP/HTTP server（旧 gemini-cli 有 `--acp`，agy 没有——社区 agy-acp 桥佐证）；CLI 与旧版非 1:1 功能对等（缺 mode 选择/diff 视图等） |
| 判档 | **A-（真·库级、引擎自包含；扣分 = preview 未 GA、官方仅 Python、个人账号停服后产品重心在企业/API key 路径）** |

### 3.5 Hermes Agent（Nous Research）（型 5，B/C）—— 无官方库级 SDK

| 维度 | 结论 |
|---|---|
| 身份锚点 | `NousResearch/hermes-agent`（MIT），Python ≥3.11；本机 v0.21.0（upstream 2026-09-03）；官方主路径 = curl git 安装（`~/.hermes/hermes-agent` + uv venv）；PyPI `hermes-agent` = 整个 CLI 本体（extras: web/pty/acp/mcp/all），**0.19.0 滞后 git 两版** |
| SDK | **不存在 `createAgentSession` 形态的官方库级 SDK**。官方最接近的嵌入面：① 源码 import——`from run_agent import AIAgent`（`chat()`/`run_conversation()`；官方 python-library 指南明言"不发布受支持的库嵌入 wheel"，正路 = git clone + uv sync；**AIAgent 非线程安全、无事件句柄式 API**，事件经返回 dict/回调）；② **serve JSON-RPC/WS 协议**（`hermes serve`，默认 127.0.0.1:9119；tui_gateway 方法/事件目录公开，实现 Pi 风格 RPC 映射：prompt.submit / session.steer / session.interrupt / session.history / approval.respond…，README "write Python scripts that call tools via RPC" 即指此）；③ **OpenAI 兼容 HTTP**（api_server：`/v1/chat/completions`、`/v1/responses`、`/v1/runs`+SSE、`/api/sessions|jobs`、`/v1/skills`，Bearer `API_SERVER_KEY`）；④ ACP/MCP server。Desktop Plugin SDK 仅 UI 扩展，不能编程式起会话 |
| 注入/订阅 | 协议面有事件流（message.delta/complete、tool.start/complete、approval.request）；配置/模型/provider 注入在 serve 配置或 OpenAI 兼容层；无 OMP 式运行期 Settings/ModelRegistry 注入面 |
| 认证/现场 | 隔离单元 = **profile**（每 profile 独立 config.yaml/.env/SOUL/skills/会话/鉴权，不共享 bot token）→ wrapper 应走专属 profile；但 serve/dashboard 需往用户同一 venv 装 `[web]/[pty]` extras（**侵入用户现场**）；2026-06 硬化后非 loopback 绑定强制 auth（fail-closed），loopback 默认免鉴权 |
| 保真 | 协议面驱动的是同一个 `AIAgent` core，tools/memory/skills/cron/gateway 全保留；功能全度 TUI gateway JSON-RPC ＞ ACP ≈ API server（HTTP 兼容面少一档但有 runs/steer/approval） |
| 判档 | **B/C（无官方 SDK = 与用户现场共享同一安装/数据面；协议桥可行但适配成本与侵入度最高的一档）** |

### 3.6 DSH（DeepSeek Harness）（型 6，平台方）—— 被 embed/被 wrapper 的对象

| 维度 | 结论 |
|---|---|
| 定位 | "Everything is Plug-in"：host 核心 + cordis **patch 行模型** + bundle 组合面；dsh = 平台，不适用"wrapper 不破坏原生"标尺（它自己就是被包对象） |
| 开放面 | ① 插件标准（bundle/patch/provider/service，`apply(ctx)`+inject、schemastery config、fail-open）；② `packages/sdk`（产品面 "full SDK"）+ apps/cli/web；③ **ACP**：`@deepseek-ai/dsh-acp` = automation-only ACP server（JSON-RPC stdio，`dsh --profile acp` 即起）+ **`@deepseek-ai/dsh-subagent-acp` = 通用 ACP client**（"child can be any ACP-compatible agent, not just Harness"——每 run 起子进程 → ACP session → 任务 → final answer，permission 自动应答）；④ webServer HTTP（主要自消费） |
| 对上层意义 | **中枢宿主候选**：`dsh-subagent-acp` 已是"把任意 ACP 运行时当 out-of-process 子代理"的现成拼图；引擎（Node v22 host）与异构 agent 之间天然进程隔离 |
| 判档 | 平台方——与其"SDK"对接 = 以插件写 wrapper，或以 ACP client spawn 异构 agent |

---

## 4. 横向对照矩阵

### 4.1 SDK 一览（六家，2026-09-05）

| 运行时 | 官方 SDK？ | 语言 / 包 | SDK 架构 | 核心引擎归属 | 版本线 |
|---|---|---|---|---|---|
| OMP | ✅ 一等 | TS（npm `@oh-my-pi/pi-coding-agent`，18.1.10） | **型 1 库级 import**（Bun 进程内） | wrapper 自带（随我们 bundle） | 单一（registry 锁版） |
| Claude Code | ✅ 一等 | TS `@anthropic-ai/claude-agent-sdk` 0.3.261 / Py `claude-agent-sdk` 0.2.152 | **型 2 自带 core + spawn claude 子进程（stdio）** | wrapper 自带（SDK 捆绑 core） | CLI/SDK 双线快发（0.x） |
| Codex | ✅ 一等 | TS `@openai/codex-sdk` 0.153.4 / Py `openai-codex` 0.144.4 | **型 2 自带运行时 + spawn `codex app-server`（JSON-RPC）** | wrapper 自带（SDK pin 运行时 wheel） | **三线不同步**（CLI/TS 同、Py 独立） |
| Antigravity | ✅ preview | 官方仅 Python `google-antigravity` | **型 1 库级 import（wheel 内嵌 runtime）** + 型 4 Interactions API | wrapper 自带 | preview，演进中 |
| Hermes | ❌ 无库级 | （PyPI `hermes-agent` 只是 CLI 本体） | 型 5：源码 import `AIAgent` / serve JSON-RPC / OpenAI 兼容 HTTP / ACP/MCP | 用户现场（共享 ~/.hermes） | git 日更 / PyPI 滞后 |
| DSH | 平台 | 插件 patch 标准 + `packages/sdk` + ACP server/client | 型 6：被 embed 的对象 | — | registry tag（alpha 线） |

### 4.2 OMP-SDK 标准两轴判定

| 运行时 | ①保真（原生 core 功能继承） | ②现场零破坏（独立部署、不碰用户安装/登录态） | 需注意 |
|---|---|---|---|
| OMP | ≈100%（同一核心） | ✅ 引擎随 bundle；数据面 ~/.omp 共享需双版本对齐轮验证 | Bun 引擎墙（dsh=Node 需 Bun sidecar） |
| Claude Code | 高（跑原生 core；非 100%：teams/preset 缺口） | ✅ 自带二进制 + `CLAUDE_CONFIG_DIR` 私有 + API key 即全隔离 | ToS：不得自称 Claude Code / 不得转售 claude.ai 登录 |
| Codex | 高（原生 harness；经间接层） | ✅ 自带 pin 运行时 + API key/CODEX_HOME 隔离 | 多版本线漂移；mcp-server 已弃 |
| Antigravity | ≈100%（库级同 harness） | ✅ wheel 内嵌 runtime + API key | preview；官方仅 Python；产品重心转向企业 |
| Hermes | 协议面驱动同一 core（全保留） | ⚠️ 需 profile 隔离 + 给用户 venv 装 extras；serve 硬化后 loopback 免鉴权 | 无官方 SDK = 最高适配成本 |
| DSH | —（平台） | — | 作为中枢宿主候选 |

---

## 5. 结论与上层启示

### 5.1 光谱结论

1. **"官方 SDK"是个光谱，不是开关**。A 档四家 SDK 有一个共同设计：**引擎自包含**（OMP/Antigravity 在库内、Claude/Codex 在捆绑二进制里）→ "不破坏用户已装现场"是它们的默认属性而非我们要绕的坑；与用户环境的共享面（~/.claude、~/.codex、~/.gemini、~/.omp）都**可以**用配置/环境变量隔开。
2. **进程内库 vs 子进程协议驱动**是唯一显著的工程分叉：型 1（OMP/Antigravity）同进程 = 事件/工具/生命周期零序列化损耗、可注入 Settings 层；型 2（Claude/Codex）跨进程 = 事件面是协议化的（仍完备：流式事件/abort/hooks/subagent/session 管理），但要接受 spawn 开销与协议契约漂移（两家都在 0.x 快发）。
3. **Hermes 是唯一"无 SDK"档**——它是六家里唯一的 open-source 全栈运行时，官方选择把嵌入面做成协议（serve RPC/OpenAI 兼容/ACP/MCP）+ 源码 import，而非 SDK 包；wrapper 若要做 Hermes Web UI 或 Hermes Adapter，本质是"协议桥 + 与用户共享 ~/.hermes（用 profile 隔离）"，成本显著高于 A 档。
4. **DSH 不做"SDK"而是做"宿主"**——若上层平台以 dsh 为中枢，异构接入 = 在 dsh 里给每个运行时配一个 provider（ACP client 已有现成实现）。

### 5.2 对 A2A Communication Platform（Adapter 选层指南）

| 运行时 | Adapter 首选 | 次选/回退 | 备注 |
|---|---|---|---|
| OMP | `@oh-my-pi/pi-coding-agent` SDK（Bun sidecar） | `omp --mode rpc`（现役） | SDK 可运行期注入 role/fallback + 订阅事件（现有 omp-web 已论证） |
| Claude Code | Claude Agent SDK（TS/Py） | CLI `stream-json` 行协议 | SDK = 官方唯一推荐 embedding 面 |
| Codex | Py/TS Codex SDK（内部 app-server JSON-RPC） | 直连 `codex app-server` 协议 | mcp-server 已弃；勿走 CLI spawn 当主通道 |
| Antigravity | `google-antigravity`（Python 库级） | headless `agy -p --output-format stream-json` | SDK preview 期要锁版本跟 changelog |
| Hermes | serve JSON-RPC/WS（tui_gateway，语义最全） | OpenAI 兼容 HTTP / 源码 AIAgent | 每租户/每环境 profile 隔离 |
| DSH | 插件 provider 或 `dsh-subagent-acp` | — | 本身就是中枢宿主 |

### 5.3 对 Agent Orchestration Platform

- **可进程内嵌入**（同进程编排）：OMP（Bun）、Antigravity（Python）——事件/工具零边界；
- **只能子进程外包**（进程隔离编排）：Claude Code、Codex、Hermes（协议驱动，事件完备可订阅）——每会话一进程是官方模型，编排器只需管 spawn/回收；
- 编排器统一事件词表可借鉴 dsh-omp-provider.md 的 RPC→SessionEventMap 映射先例（各家事件名不同，需要一个中性事件模型）。

### 5.4 对单运行时 Web UI（OMP Web 式）

- OMP Web 结论可直接推广：**SDK 型运行时做 Web UI = 自包含引擎的 sidecar/gateway**（Claude Code/Codex/Antigravity 均可行且不碰用户现场）；
- Hermes 型运行时做 Web UI = 直接连它自带的 `serve`（官方已有 dashboard 架构，别重造）。

### 5.5 未决 / 建议下一步

1. **授权/条款逐家核**（Claude Code ToS、Codex、Antigravity preview 条款）——SDK 可用性之外，商用 wrapper 的法律边界要先于 PoC 确认；
2. **A 档四家各做一个 30 分钟级 SDK 冒烟**（起会话 → 注入 prompt → 订阅事件 → abort → 隔离目录验证），把"协议漂移/缺口清单"落成表（立项后）；
3. Hermes 若进范围，先定"profile 隔离 + serve 桥"原型，评估与用户现场共存的实际侵入；
4. 所有 SDK 依赖一律**精确锁版**（Claude 0.x / Codex 三线 / Antigravity preview / OMP registry tag），升级走对齐轮。

---

## 6. 证据清单

### 6.1 本机取证（2026-09-05）

| 项 | 证据 |
|---|---|
| OMP | `~/.local/bin/omp` v18.0.11；`omp acp` help："Run Oh My Pi as an ACP server over stdio" |
| Claude Code | `claude --version` = 2.1.250；`claude --help` 无 `acp` 子命令；`claude-agent-acp`（@agentclientprotocol v0.39.0，README "powered by the Claude Agent SDK (TypeScript)"）与 `@zed-industries/claude-code-acp` v0.16.2 在 ~/.local/lib/node_modules |
| Codex | `codex --version` = codex-cli 0.142.3（npm @openai/codex launcher）；子命令含 exec/mcp/mcp-server/app-server[exp]/remote-control[exp]/exec-server[exp]/cloud[exp] |
| Antigravity | /opt/Antigravity-x64 = Electron（Chromium 沙箱特征）；~/.gemini（旧 gemini-cli 配置）含 antigravity/antigravity-cli 子目录；~/.config/Antigravity 桌面 profile |
| Hermes | `~/.local/bin/hermes → ~/.hermes/hermes-agent/venv/bin/hermes` v0.21.0，upstream NousResearch/hermes-agent commit 63279301bc；console_scripts = hermes / hermes-acp / hermes-agent；`hermes serve --help`（JSON-RPC/WS gateway，9119，2026-06 硬化 auth）、`hermes acp --help`、`hermes mcp serve`、`hermes send` 均本机实证 |
| DSH | 全局 dsh v0.1.2-alpha.3；upstream checkout packages/：`acp`（@deepseek-ai/dsh-acp，ACP server）、`bundle/acp-app`、`subagent/subagent-acp`（通用 ACP client）、`sdk`、`mcp` |

### 6.2 来源 URL（按家）

- **Claude Code**：官方 docs [llms.txt](https://code.claude.com/docs/llms.txt) → [setup](https://code.claude.com/docs/en/setup) / [headless](https://code.claude.com/docs/en/headless) / [agent-sdk quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart) / [agent-sdk hosting](https://code.claude.com/docs/en/agent-sdk/hosting) / [agent-sdk migration-guide](https://code.claude.com/docs/en/agent-sdk/migration-guide) / [claude-code-features](https://code.claude.com/docs/en/agent-sdk/claude-code-features)；npm [@anthropic-ai/claude-code](https://registry.npmjs.org/@anthropic-ai/claude-code/latest)、[@anthropic-ai/claude-agent-sdk](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/latest)；PyPI [claude-agent-sdk](https://pypi.org/pypi/claude-agent-sdk/json)
- **Codex**：GitHub [openai/codex](https://github.com/openai/codex)（releases：0.153.4；codex-rs/cli、app-server、exec-server）；[Codex SDK 文档](https://developers.openai.com/codex/codex-sdk)；npm [@openai/codex](https://registry.npmjs.org/@openai/codex/latest)、[@openai/codex-sdk](https://registry.npmjs.org/@openai/codex-sdk/latest)；PyPI [openai-codex](https://pypi.org/project/openai-codex/)
- **Antigravity**：[改名公告](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/) / [I/O 2026](https://antigravity.google/blog/google-io-2026) / [SDK 博客](https://antigravity.google/blog/introducing-google-antigravity-sdk) / [antigravity-sdk-python](https://github.com/google-antigravity/antigravity-sdk-python) / [CLI headless](https://www.antigravity.google/docs/cli/headless.md) / [Gemini API Antigravity agent](https://ai.google.dev/gemini-api/docs/antigravity-agent)；旧 CLI [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli)
- **Hermes**：[NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) / [docs](https://hermes-agent.nousresearch.com/docs/)（guides/python-library · user-guide/features/api-server · developer-guide/programmatic-integration · user-guide/profiles · user-guide/features/mcp · user-guide/features/acp）/ [PyPI hermes-agent](https://pypi.org/project/hermes-agent/)
- **DSH**：本机 @deepseek-ai/dsh v0.1.2-alpha.3 + upstream checkout（packages/acp、subagent/subagent-acp 的 package README）
- 交叉佐证：本仓 `docs/plans/dsh-omp-provider.md`（ACP/RPC 实测）、`docs/upstream-dsh-0.1.2-alpha.5-report.md`（dsh 产品面）
