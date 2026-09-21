# 最小 cordis 宿主而非自写 BFF

DSH Web UI 的 4 条 wire 契约（静态资产/boot graph/unary RPC/WS mux）需要一个服务端实现。我们选择复用上游的载体插件（webserver / frontend-static / client-modules / connection / gateway）跑一个"最小 cordis 宿主"，SessionController 以下由自有 Provider 替换，而不是自写 ~600 行 BFF：WS mux 帧格式无兼容承诺，自写意味着每次上游升级都要重新对帧；复用 gateway 让 wire 面 100% 原样。上游该层"无稳定性承诺"的风险由 exact-pin + bun compile 内嵌（ADR 0005）对冲。

## Considered Options
- 自写 BFF（剥离研究 §2.2）：薄胶水但欠复刻 WS mux，长期对帧负债。
- 物理资产抓取（研究方案二）：被研究否证，工作量与自写 BFF 相同且无版本锚。

> **2026-09-08 v0.3 精化**（蓝图 §3.6 / 决策 #20）：替换层的实际形态是 **thin routing mux**——
> superD 自有 namespace（`machines.*` / `superd.*`）本地应答，其余按 active adapter 转发；DSH 三面
> （session / workspace / settings）**全透传**（UI 与上游锁死同版 ⇒ 契约逐字节一致）。"替换"不等于
> "重实现"，本 ADR"不自写 BFF"的结论进一步强化。
