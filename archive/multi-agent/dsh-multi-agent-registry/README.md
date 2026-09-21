# @pgmi-builds/dsh-multi-agent-registry

`MultiAgentRegistry extends AgentRegistry`（上游 `@deepseek-ai/dsh-agent` @ `0.1.3-alpha.2`）：单槽 `setFactory` → 多槽 Map（`appendFactory(key, …)`），`create/resume` 委托处投递时路由。设计正本见 `docs/02-dsh/multi-agent-registry.md`。

## 构建引导（type wiring，as-built）

类型解析走**仓根 `node_modules`**（上游已装 exact-pin 发布版 `@deepseek-ai/dsh-agent@0.1.3-alpha.2`、`@deepseek-ai/cordis@4.0.2`，含 `.d.ts`）——不用 tsconfig paths 指上游源码（上游 tsx 源形态 tsc 不可编译），也不 vendored types（仓根已是同版超集）。

```bash
npm install --cache .npm-cache        # 仓根，装出 node_modules（gitignored）
npx tsc -p apps/multi-agent/dsh-multi-agent-registry
```

fresh clone 必须先跑仓根 install，否则既无类型也无 dist。发布（解除 `private: true`）时再评估 vendored types 自举。

## 已知边界（M1 待修）

- `#append` 未做 `symbols.original` 规范化（上游 `setFactory` 有）：traced/shadow factory 传入时归属追踪会丢。M0 唯一调用方（agent-loop 原始实例）不受影响；引入 `appendFactory` 消费者时修复（spec §六.1 关联项）。
