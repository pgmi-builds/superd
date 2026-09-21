# packages/dsh-multi-agent-registry — AGENTS.md

本文件是 `packages/dsh-multi-agent-registry` 子目录的 AGENTS.md。上层为 `apps/multi-agent/AGENTS.md`（app 级规则 + ForeignAgent 集成契约在那里）；再上是仓根 `AGENTS.md`。冲突时以本文件为准。

设计正本：`docs/02-dsh/multi-agent-registry.md`；实测报告：`docs/test-reports/`。本文件只记**疤**——实测踩过、spec 之外或极易再踩的坑（全部 2026-09-09 M0/M1 实证）：

1. **禁止一切 `#` 真私有成员（字段和方法）**：cordis 服务经 prototype/proxy 委托调用，`#` 是 per-instance brand，proxy 接收者从未跑过构造函数 → `Receiver must be an instance of class …` 必炸。上游全用 TS `private` 普通成员不是风格，是硬约束。
2. **整插件替换 = 禁原行 + 插新行**：cordis-plugin-include（0.1.3-alpha.2）把 patch 行 `name` 解构为守卫专用、永不赋值——“name 重指”不存在。形态：`{id: agent, name: 原值守卫, disabled: true}` + `insert {id: agent-multi, …}`。
3. **RPC 面走 `connection.fetch.register`，不走裸 `webServer.register`**：`/api` 前缀归 client-connection 所有（Host/Origin fence + 认证在其 handler 内）；裸 register 同前缀会 longest-prefix-win **绕过栅栏**（安全漏洞，不是风格问题）。
4. **管道原则（spec §4.1，违反即设计缺陷）**：registry 层唯一职责 = 读一个键、选一个 factory；`options` 经 `Reflect.apply` 原样透传（测试有引用同一性守护）。禁止检查/改写任何非 runtime 字段。
5. **类型接线依赖仓根 node_modules**（exact-pin 发布版类型）：fresh clone 先在仓根 `npm install --cache .npm-cache` 再 `tsc`；详见包 README 构建引导。
6. **symbol 互op 的实例纪律**：cordis 系 symbol 全是 `Symbol.for`（跨实例安全，本包的 `symbols.original` 无恙）；`@deepseek-ai` 系存在裸 `Symbol()` 互op 键（dsh-scope 已证）——本包若未来 import dsh 系包做 symbol 互op，先查其定义方式，必要时从宿主实例解析（见 agent-loop-echo 的疤 4）。

测试纪律：单测 fake-ctx（`effect` 立即执行返回 disposer；`reflect.provide/inject/accessor/on` no-op 面）；包目录内 `node --test test/*.test.mjs`（Node 22 目录参数形态不可用）。集成验证按仓根 §三 dsh-plugin 线契约（systemd-run、0.0.0.0、验收模式交用户）。
