# agent-agy adapter 计划（AW-G，2026-09-18）

> Google Antigravity CLI（`agy`）adapter。规则正本：`apps/agent-worlds/agent-adapter-dev-rules.md`（本计划同时落 §16）。
> 本计划只做调研结论 + 接线裁决；实现按 bite-size 任务推进，每任务独立可测。

## 1. 接口选型调查（2026-09-18，web + 本机实证）

候选面与本机事实（`agy 1.2.6` @ `~/.local/bin/agy`，native home `~/.gemini/`）：

| 候选 | 现状 | 裁决 |
|---|---|---|
| **ACP**（`agy --acp`） | **不存在**。官方 issue `google-antigravity/antigravity-cli#31` 开放中；社区 `agy-acp`（多个 fork）均为 PTY 包裹 + 读 `~/.gemini/antigravity-cli/conversations/*.db`（SQLite+protobuf）重建事件 | **falsified**。无原生面；社区桥依赖 native 会话存储格式（违反 §14 mapping-only：绝不解析 native 会话存储） |
| **A2A** | 无 CLI/SDK 级 A2A server 面；A2A 属托管 Interactions/Managed Agents 云侧 | **falsified**（本 adapter 范围） |
| **Python SDK** `google-antigravity` | 库级 import、wheel 内嵌 Go runtime；**仅 API key / Vertex ADC 认证，无 OAuth/订阅路径**；Python 语言（本线全 TS/node）；本机未安装 | **falsified as primary**。认证面分裂（native home 的 OAuth token 用不上）、跨语言 IPC；API-key 用户才考虑的旁路面，登记为 per-adapter 开放项 |
| **CLI headless stream-json**（`agy --print --input-format stream-json --output-format stream-json`） | 原生支持：常驻 stdin/stdout NDJSON 流水，每 turn 一个 `result` 事件；`--conversation <id>` resume、`--continue`；`--model/--effort/--mode/--agent` launch-only；未知 `--model` 非零退出 fail-loud；权限 headless 下走 policy（软拒/`--dangerously-skip-permissions`/`--sandbox`） | **选定**。与 claude 线（spawn CLI、SDK 持事件流）同构；走 native `~/.gemini` 认证，零重定向（§5） |

选型依据：§3.3 SDK 优先在此**显式 falsify 一次**——SDK 存在但认证面与 native home 断裂；CLI 是唯一 OAuth-native 且有结构化事件流的程序面。这与 §4 per-adapter 决策权一致，落档即合规。

## 2. Home 与进程纪律（§5/§13/§14 套用）

- native app home = `~/.gemini`（spawn **零重定向**；不造 `GEMINI_HOME` 类 knob 进 prod 路径；测试隔离待验——CLI 若无 home env knob，则隔离测试降级为真 home 只读探针 + 真 turn 手测）。
- world DSH home = `$DSH_HOME/agents/agy`（DSH 会话日志、`dsh-sessions.json` 映射）。
- profile = `$DSH_HOME/profiles/agy`。
- **lazy spawn**（§14-i）：view/create/resume 零进程；首个真实 prompt 才 spawn `agy` 子进程；**turn prompt 永不自动重试**；spawn/handshake 瞬态失败 ≤3 次（对齐 hermes 先例）。
- **mapping only**：`dsh-sessions.json` = `dshSessionId → { conversationId, cwd, createdAt, preset }`。`--conversation` resume 需要的 id 首个 turn 后才成立——与 codex 同缝（§8 开放项），照 codex 方案：派生 id `session-agy-<conversationId>` 或持久映射，实现时收敛。
- **DSH log 单一主笔**：DSH-native session 持久化（§10 路线），transcript/list/replay 全走 DSH 服务；`~/.gemini` conversations DB **绝不回读**。

## 3. 接线域裁决（§3 对照表）

| 接线域 | 供给方 | 要点 |
|---|---|---|
| spawn/resume | CLI stream-json 常驻子进程 | `--conversation <id>` resume；`--model/--effort/--mode` launch-only |
| events → dsh | NDJSON stream-json 事件 + adapter 投影 | assistant 增量、tool 调用、usage、`result` 终态 → §11 词汇（turn/step 不变量！） |
| model list | CLI `agy models`（**manual opt-in 探针**，§14-ii；需已登录） | 默认模型推 `agentDefaultModel.saveSelection()` |
| 会话清单 | DSH-native（DSH log 权威） | 不扫 `~/.gemini` |
| 审批 | **降级**：headless 无交互审批 → launch-only preset（default / `--mode accept-edits` / `--dangerously-skip-permissions` + `--sandbox`） | 与 codex 同级降级，登记在案 |
| slash/skills/mcp | `agy mcp/plugin` 命令级能力 = **未接**（§3.3 尾条款预留） | 登记 |
| usage/ctx 上限 | stream-json usage 事件 + `agy models` 目录 | 滞后语义按实测登记 |

## 4.2 消费者优先路线定版（2026-09-18 user 裁定，dev-rules §16a）

- **认证入口 = Gemini API key**（消费者获取成本最低）；ADC/GCP 降为可选加分（SDK 自动利用，adapter 不要求）。选型硬门：候选面必须支持 API key 消费。
- **实测裁决**：SDK ✅（`GEMINI_API_KEY` env 自动读取、真打 Google 鉴权通过、无 geofencing；429 = key 余额）；CLI headless ❌（喂 key + modelProvider gemini 仍强制 OAuth，临时 HOME 复现）。⇒ **SDK 唯一胜出**，CLI 从 live 与探针双面整体退出；model list/默认模型 = 磁盘读 + catalog 静态捕获（零认证）。
- **S0 onboarding 改版**：无 `GEMINI_API_KEY` 时，临时 DSH 会话引导用户去 AI Studio 取 key、paste 回会话（§17 流程，URL/文本 → message，失败 context injection 作废）——不再是 gcloud ADC 流，更不是 agy OAuth。
- **§4.1 方案一细节仍有效**，仅认证主面从 ADC 换为 API key：薄 Python bridge（node ↔ JSONL ↔ python-sdk ↔ localharness）+ lazy spawn；`save_dir` 指 world home；工作 key 补充余额后补一个全绿真 turn。

## 4.1 方案裁定（2026-09-18 user 方案一/二 → 方案一实测通过）

- **方案一（SDK 直连）：WORKS**。实测链路：venv 装 `google-antigravity@0.1.17` → `LocalAgentConfig(model, vertex=True, project, location, workspaces, save_dir)` → `Agent.chat()` 消费 chunk 流 → 真 turn 回 "OK"（ADC service account，零 OAuth）。指标：import 0.42s / session spawn 0.49s / 组合 RSS ~160MB（python ~68 + localharness ~90）/ turn 3.9s（服务端）。localharness **读本机 user data**（`~/.gemini/antigravity-cli/settings.json`、写 `~/.gemini/antigravity/`）；`save_dir` 可显式指 world home（SDK 缺省 mkdtemp = runtime 视其为可置换）。SDK 无 model-list API → catalog 仍走 CLI manual 捕获。
- **实现形态注意**：SDK 是 Python 面，本线 adapter 是 TS/node ⇒ 需**薄 Python bridge 子进程**（JSONL over stdio，node ↔ python-sdk ↔ localharness）——这是被 SDK 能力正当化的 sidecar（对照 §14-i lazy spawn：bridge 首个真实 prompt 才物化），或后期研究 localharness 直连协议（`localharness_pb2` 在 SDK 内）去 Python 化，登记为远期项。
- **方案二（CLI + 浏览器 OAuth）：不再需要**（live 面已通）；仅当需要 `agy models` catalog 捕获时才回到 CLI auth 问题（或让 user TUI 内 `/model` 面板人工抄录一次）。

## 4. 已知风险 / 前置（2026-09-18 auth 实测更新）

1. **认证实测（agy 1.2.6，2026-09-18 二轮）**：user 的 TUI **确已登录**（TUI 进程在跑、token 19:51 刷新、access 有效）。headless 报 "Please sign in" **不是环境/沙箱/进程树问题**（dbus 齐全、`systemd-run --user` 复现同样失败、复制 HOME 排除 TUI 锁后仍失败）。**根因证据**：CLI log `error getting token source: You are not logged into Antigravity` + `Auth mode is unspecified`；token 文件 `auth_method: "gcp"`（Vertex 味）。⇒ **1.2.6 的 print/headless 路径只认 Antigravity 账号 OAuth token source，不消费 TUI 的 Vertex(gcp) 味登录**；TUI 交互路径把 AuthMode 显式传给 language server 所以能用。v1.1.9（2026-08-01）headless 曾验证可用——疑 1.2.x 回归或 Vertex 登录 + headless 组合不受支持。**这是 live-session 面（stream-json 同属 print 族）的真实阻塞**：出路 = ① user 补一次账号 OAuth 登录（antigravity.google 回调流）；② 查上游是否已知问题/新版本修复；③ 不可解则 adapter live 面降级方案需重议。app-wide 配置不受影响（见 3）。
2. **接口分工裁决（user 2026-09-18 释疑，修正 §1 表述）**：agy **没有** claude 式「CLI 只管探针、SDK 管活会话」的二分（Python SDK 已 falsified）。agy 的分工是**同一 CLI 的两个面**：
   - **live session（new/resume/prompt）= CLI headless stream-json 常驻子进程**（`--input-format/--output-format stream-json` + `--conversation <id>`）——等价于 claude 线里 SDK 扮演的角色；
   - **app-wide 探针（model list / 默认模型）= CLI 子命令 manual opt-in**（`agy models`，§14-ii，用后即弃，绝不为此 spawn 会话）。**实证（2026-09-18）**：`agy models` 纯接口、不启 TUI/GUI 会话（systemd-run 实测 578ms / 186MB 即退）；且 user 判断正确——**配置文件自带数据**：`~/.gemini/antigravity-cli/settings.json`（CLI 真身配置，≠ legacy `~/.gemini/settings.json`）已含当前默认模型 `"Gemini 3.7 Flash (Medium)"` + `gcp.project/location`；完整 catalog 仍需 `agy models`（当前受 auth 阻塞，一次性手动捕获即可，不进 prod 路径）。
   - claude 对照：claude = CLI spawn 仅 boot 探针（`supportedModels()`），SDK（`@anthropic-ai/claude-agent-sdk`）持活会话；agy = CLI 双面兼任。
3. **spawn env 注入（auth 舱）**：adapter spawn 子进程时注入 `GOOGLE_APPLICATION_CREDENTIALS=$VERTEX_CREDENTIALS_PATH` + `GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_REGION`（值来自**运行环境既有变量**，不硬编码、不落盘、不写 native settings）——这是 auth 面 env 传递，不是 §5 意义上的 home 重定向/配置拷贝，合规。
4. stream-json 成功路径事件词汇（增量/工具调用/turn 生命周期）仍需登录后 S1 采样。
5. 子进程生命周期（idle 自退与否）待实测。
6. `agent-hub` roster/selector 桥照 pi/hermes 模板；无新 hub 改动预期。

## 5. 任务序列（bite-size，每项独立验收）

- **S0 onboarding 桥接（dev-rules §17 首个落地）**：无登录证据时创建临时 DSH 会话 → spawn `agy`（headless 族）捕其认证 URL → URL 作为 message 发给用户 → paste back 的 code 喂回 stdin → 成功则同会话下一真实 prompt 触发真 session（lazy）；失败则 context injection 作废该会话。**待验**：paste-back 后 agy 是否写 token 并继续同进程（headless auth 路径是否与 gcp 味 token 冲突——§4.1 阻塞的旁路验证）。
- **S1 事件字典采样**：登录后手工跑一次 stream-json/SDK 真 turn，逐行记录事件形状 → 落本计划附录（事件→DSH 词汇映射表）。*无代码改动。*
- **S2 包骨架**：`agent-agy/`（`@pgmi-builds/agent-adapter-agy`），standalone 形态（§1-A）跑通 boot；`agy-client.ts`（spawn + NDJSON 解析 + lazy + ≤3 spawn 重试）+ 单测（fake 流，管道级）。
- **S3 会话面**：create/prompt/resume + `dsh-sessions.json` 映射 + DSH-native 持久化；standalone 真 turn 验收（create→prompt→readback HTTP wire + 浏览器）。
- **S4 投影完整化**：tool 调用/usage/model 元数据 → §11 事件；permission preset 三档。
- **S5 world 桥**：hub roster 挂载（照 pi 模板），4999 联测，用户手测验收。
- **S6 文档收尾**：本计划附录 + acceptance report + dev-rules §16 状态更新。

## 6. dev-rules §16（随本计划新增）

见 `agent-adapter-dev-rules.md` §16：接口选型裁决（ACP/A2A/SDK falsified，CLI stream-json 选定）+ home/lazy/mapping 套用记录。
