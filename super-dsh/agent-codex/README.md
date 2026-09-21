# @pgmi-builds/agent-adapter-codex

superd 外壳下的 **Codex adapter**（agent-worlds 线，AW-E）：把 Codex CLI 经由
`@openai/codex-sdk` 接进 DSH —— 会话、事件、模型目录、持久化全部按 DSH 语义呈现，
WebUI 消费的是 DSH 服务提供的数据面。

> 通用规则（定位 / 两形态 / 测试准则 / 接线域 / per-agent 定制权 / home 与 profile 布局）
> 见上级目录的 `agent-adapter-dev-rules.md` —— 改本包前先读它。

## 它是什么

- 一个**普通 dsh plugin bundle**：`package.json` 的 `dsh.bundle.patch` 指向本目录的
  `cordis.patch.yml`（挂 codex provider、关掉它替代的原生行、重写权限三档表、pin 应用内目录选择器）。
- 一个 **AgentFactory**：`src/index.ts` 里的 `CodexProvider` 在 `ctx.agents` 注册工厂，
  每个会话一个 `CodexSdkClient`（真 `@openai/codex-sdk` 线程）；`src/agent.ts` 把 Codex 线程事件
  投影成 DSH 会话事件。
- **不包含** 任何 hub 耦合：世界挂载由 hub 侧驱动（AW-B 用 `@pgmi-builds/agent-hub/world` 的
  mount carrier）。本包自己就足以点亮一个完整的 web app。

## 单独跑起来（首选开发/验收形态）

```bash
# 在仓根执行；端口默认 4988，LAN 走只绑 LAN IP 的 socat relay
AW_APP_PORT=4989 bash super-dsh/test/start-codex-app.sh
# 脚本会打印 loopback / LAN token URL；停止：
systemctl --user stop aw-codex-app-<port>-test aw-codex-app-<port>-relay
```

环境变量：`AW_APP_PORT`（端口）、`AW_APP_HOME`（默认 `$WT/.tests`）、
`SUPERD_LAN_HOST`（默认 `192.168.31.130`）、`CODEX_TRACE=1`（provider/agent 追踪）。

## Home 与 profile 布局（user 裁定）

| 位置 | 内容 |
|---|---|
| `$DSH_HOME`（测试 = `<repo>/.tests`） | 测试 DSH home |
| `$DSH_HOME/agents/codex` | **Codex app home**：`config.toml` / `auth.json` / 模型 catalog（由 `scripts/setup-codex-home.mjs` 从 `~/.codex` **单向**拷入）+ Codex 自己的 rollout/state |
| `$DSH_HOME/profiles/codex` | 本 app 的 dsh profile（bundles + `cordis.patch.yml`） |
| `$DSH_HOME/sessions/...` | **DSH 会话日志**（上游 `session-persistence-jsonl`，zstd）——list/replay 都由此提供 |

**禁止**自造 per-app home（如 `.tests/codex-app`）。

## 关键实现点

- **session 身份 = 一对一映射**：DSH session id 是权威；Codex thread id 在其物化后写入
  `<codexHome>/dsh-sessions.json`（`src/session-map.ts`）。resume 只经该映射重挂线程，查不到即
  fail-closed。**不自建 rollout 扫描做 list，也不自解析 JSONL 做 replay。**
- **DSH-native 持久化**：工厂按上游 agent-loop 的方式持有写通道（create `persistence.create` /
  resume `persistence.open(id,'write')` → `read` → `interruptedTurnClosers` → `prepare`），
  发布点刷未存后缀，dispose 时 `handle.close()` 排空。
- **每会话路由钉住**：工厂在 create/resume 时同步钉住本会话路由（追加 `model/selection` +
  `installModelSelection`），**不依赖全局默认模型的落盘时序**（共享 test home 里 settings 默认可能属别线）。
- **事件映射**：`system/message`（Codex 系统提示，rollout HEAD `base_instructions`）、
  `request/context`（provider/model/contextWindow）、`assistant/message`（reasoning 用
  `{type:'reasoning',text}`）、`tool/call`（原始 JSON 串）/`tool/result`、`step/start|end`、`turn/start|end`。

## 测试

```bash
npm run build                                   # tsc strict
DSH_HOME=<repo>/.tests \
SUPERD_DSH_ANCHOR=<repo>/upstream/deepseek-harness/package.json \
node --test test/*.test.mjs
```

live 门控：`AW_CODEX_LIVE=1`（会真跑一次 Codex turn）。

## 已知边界（V1）

- 审批仅 launch-only 预设（SDK 无运行时审批；app-server 线才有 `*/requestApproval`）；
- 无 steer / 无运行时换模型（下一轮生效）/ usage 滞后一轮 / 无 fork；
- `compaction/*`、`todo/write`、`subagent/*` 未接（见规则文档 §9.4 backlog）；
- **AW-B world 挂载移植**：本包已无 world-plugin；若要在 AW-B 的 mount carrier 下作为世界被挂载，
  由 hub 侧驱动（移植为跟踪项）。
