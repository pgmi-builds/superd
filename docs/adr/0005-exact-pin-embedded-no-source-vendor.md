# exact-pin + 构建期内嵌，永不改上游源码

上游依赖（cordis 系列 + dsh-web-app 系列）以精确版本锁进仓（禁用机器全局包），由 bun compile 嵌入交付物，源码不提交进仓；一切修改走 cordis patch 机制或自有插件。vendor 保护由 `superd vendor verify`（hash 比对）与 `superd vendor restore`（registry 重拉覆盖）承担。理由：提交源码会制造 313MB 级仓库负担与"手滑改 vendor"的风险面，而锁版+内嵌免费提供同等的环境完整性与版本锚定；patch 线让上游升级随时可跟。

> **2026-09-08 v0.2 精化**（蓝图 §3.5 / 决策 #19）：dsh-web-app 系列现限**中性底座包**（roster 见
> `../01-component-boundaries.md` §4）；DSH 会话面 UI 由 `@pgmi-builds/agent-ui-*` 自有 composition
> 包承载（从上游源码 copy 起步、独立演进）——copy 出来的包属"自有插件"，不违本 ADR 的
> "永不改上游源码"。
