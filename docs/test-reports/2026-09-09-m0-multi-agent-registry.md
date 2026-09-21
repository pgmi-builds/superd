# M0 Multi-AgentRegistry 占位 PoC 实测报告

- 日期：2026-09-09
- 执行人：第一人称实测（controller 直跑，非 subagent 转述）
- 对象：`@pgmi-builds/dsh-multi-agent-registry`（branch `m0-multi-agent-registry`，commits `fede64d..6f2c7da`）
- 环境：全局 dsh `0.1.3-alpha.2`（`/home/u1/.local/bin/dsh`）；`DSH_HOME=$PWD/.superd-test`；profile `m0`（bundles: dsh-base / dsh-web-app / 本包 link:）
- 计划：`docs/superpowers/plans/2026-09-09-m0-multi-agent-registry.md`

## 结论

**通过。** MultiAgentRegistry（继承上游 AgentRegistry）完整占住 `'agents'` 生态位，原生 DSH 全功能不可区分运行：

| 验收项 | 结果 | 证据 |
|---|---|---|
| 占位（dump-config） | ✅ | `id: agent` 行 disabled（我们的 patch 所为）+ `id: agent-multi` 行 = 本包；`agent-loop` 行原样；stderr 零 warn |
| 启动 | ✅ | 4998 监听，token URL 正常，日志零 agents/typert/duplicate 错误 |
| 认证面 | ✅ | 未认证 GET / → 401 + `dsh web authentication required`；token 303→cookie → 200 shell（25309 B） |
| 会话创建（registry.create → 兼容腿 → 原生 factory） | ✅ | `session/create` RPC ok，两枚会话 id |
| 真实 agent loop 轮次 | ✅ | `session-9cee0b7c…`：turn 1 `completed`，assistant 正文 `1+1=2。`（zai-plan/glm-5.3，reasoning+text blocks，replayState 完整） |
| 重启 resume（registry.resume → 原生 factory） | ✅ | 服务器重启后对旧会话 `session-e15b5265…` 再 prompt → turn 3 正常续起（turn/start→step→turn/end 链完整） |
| 持久化 | ✅ | session.v2.jsonl.zstd 落盘，zstdcat 可读，事件序列完整（header/permission/preset/inbox/turn/step/assistant） |

会话日志证据（`session-9cee0b7c`，节选）：

```
{"type":"session","version":2,"cwd":"/home/u1/workspaces/superd","agentPreset":"standard"}
request/header config: {"provider":"zai-plan","model":"glm-5.3","maxTokens":131072}
turn/end reason: {"kind":"completed"}
assistant/message: [{"type":"reasoning",...},{"type":"text","text":"1+1=2。"}]
  source.provider: zai-plan, responseId: 202609090541354789ae7b89f1407a
```

## 过程中钉死的事实（两项均回写文档）

1. **cordis-plugin-include 0.1.3-alpha.2 的 patch 行 `name` 是守卫专用、永不赋值**——"patch 行 name 重指换插件"在本版不存在。装载形态改为：`{id: agent, name: 原值守卫, disabled: true}` + `insert {id: agent-multi, name: 本包}`。已勘误 seam/plugin/registry 三份文档（commit `efc6a85`）。
2. **cordis Service 子类禁止一切 `#` 真私有成员**（字段与方法都做 per-instance brand check，proxy 接收者必炸 `Receiver must be an instance of class MultiAgentRegistry`）。上游用 TS-private 普通成员是硬约束不是风格。两轮修复后启动通过（commit `6f2c7da`）。

## 已知限制（M0 范围内接受）

- `resolve` 恒返 `native`（M1 接路由键：session header `config.runtime` / RPC 旁路）。
- `append` 未做 `symbols.original` 规范化（M0 唯一调用方 agent-loop 传原始实例不受影响；M1 修复，见包 README）。
- 单测 9/9（fake-ctx 纯逻辑层，mutation 检查 2/2）。

## 环境备注

- 4999 被外部实例占用（未动），M0 让位 4998；实测完端口已释放，服务器已停。
- LLM 凭据：`.superd-test/.env` + `settings.yaml` 复制自 `~/.dsh`（user 指示）；默认模型因 per-session `modelSelection.lastUsed` 粘性，第一会话走错 zai 路由（无 ZAI_API_KEY），改 `agent-default-model: zai-plan` + 新会话后通过；重启 resume 旧会话仍粘 zai（credential 错误，与 registry 无关，链路验证不受影响）。
