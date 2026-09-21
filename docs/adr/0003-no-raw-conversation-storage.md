# superD 不持久化原始对话，只有 Session Pairing

Super D 永不存储任何全量模型对话——对话数据全部留在上游 runtime。它只维护一张配对表（superD session id ↔ machine/runtime/upstreamId），存在原因是 DSH Web UI 的 session id 格式与各上游不兼容、不可直传，而配对即含寻址。这是"桥接层不拥有运行时"定位的直接推论：换一台机器连同一个远端，会话照旧；superD 的数据目录永远轻。

## Consequences
- 会话历史展示完全依赖上游的回放能力（OMP 的 union persistence 即为此设计）。
- 配对表条目随上游会话消失做惰性 GC（标 dead 不立删，防上游暂时性不可见误删）。
