# 前端 Agent UI Adapter：与后端 Adapter 对偶，弃全量字段大全包

2026-09-08 accepted（蓝图 v0.2 §3.5，v0.4 §3.7 修订；决策 #18/#19/#24）

每个 runtime 落地为**一对包**：后端 `agent-adapter-x`（数据面：runtime → superD 标准字段）+ 前端
`agent-ui-x`（呈现面：标准字段 → 该 runtime 的 UI 形态）。`agent-ui-dsh` 从 DSH 会话面 UI copy
起步（精准锁版），其余 runtime 从该蓝本派生、独立演进；selector 切换 = 插件行整组换装
（Composition Registry 保证同一时刻仅一个 composition 激活——同 key 双注册会撞、list 槽叠渲染）。

**否决"全量字段大全包"**（所有 runtime 的字段/插槽往一套 UI 里累加）：5+ 个更新步伐不一的上游
之间同步一张全量表，复杂度 O(runtime × 字段)，任一上游 breaking 波及全部用户；组合层切回
O(runtime) 独立通道——用 Cordis 组合机制（换 provider = 换插件行）换维护性。

## Consequences

- 字段在场制（两半注册）保留用于**同一 runtime 内**的降级容错；跨 runtime 形态差异归组合层。
- 自有 UI **优先占用现有槽**（occupant）；owner 级 copy 仅在无现成槽可用时。实例：selector 落位
  `sidebar.footer.action` 现成 list 槽（Settings 上方），原 superd-sidebar copy 计划撤回
  （蓝图 §3.7 v0.4 / 决策 #24）——中性底座 copy 例外清零。
- 维护纪律：每个 composition 记录蓝本基线（上游精确版本号）；跟进 = diff 基线 + 选择性抄入。
- 切换机制两档：v1 整页 reload（M1）；v2 client-hmr 式 fiber 级换装（M2+）——见
  `../01-component-boundaries.md` §5。
