# M1 路由闭环 实测报告

- 日期：2026-09-09
- 执行人：第一人称实测（controller 直跑）
- 对象：`@pgmi-builds/dsh-multi-agent-registry`（路由键+RPC+original 规范化）+ `@pgmi-builds/dsh-agent-loop-echo`（首个 ForeignAgent）
- 环境：`DSH_HOME=.superd-test`、profile `m0`、4998（systemd-run unit `m1-4998-test`）、zai-plan/glm-5.3
- 计划：`docs/superpowers/plans/2026-09-09-m1-routing-loop.md`

## 结论

**主线通过**：运行期切换 = 数据写入闭环成立——RPC 改键 → 下一次投递边界路由到对应 Agent Loop，进程/WS/在飞任务零影响。**一项已知缺陷**（resume 路径持久化，见下）以 M1.1 单独跟踪。

| 验收项 | 结果 | 证据 |
|---|---|---|
| RPC 面（`/api/agent-runtime`） | ✅ | GET 返回 `{runtime, available:[native,echo]}`；POST 未知键 400；写读回环；继承 auth fence（connection.fetch.register，不绕栅栏） |
| echo 从出生生效 | ✅ | 先写键 → `session/create`（带指定 sessionId）→ agentPreset 组合通过 → 回声轮次 `[echo] …` src=echo 落盘 |
| 同会话多轮 + 活 agent | ✅ | 第二 prompt 活 agent 短路直达，12→18 事件持续落盘 |
| 键跨重启持久 | ✅ | `agent-runtime-keys.json` 原子表；重启后 GET/路由仍 echo |
| native 不受影响 | ✅ | 全程原生会话（zai-plan）正常；切换全程无重启无 WS 断 |
| **已知缺陷** | ⚠️ | resume 路径（重启后外来会话首建 agent）的轮次事件不落盘（内存正常、事件有派发、writer 注册且 buffered=0、无 warn、closers 直写 handle 成功）——M1.1 |

## 修复链（5 轮，全部上游契约对齐性质）

1. **服务访问归属**：factory 服务调用走自己的 `svcCtx`（声明 inject），`ownerCtx`（请求域）只保留发布/归属语义——上游 `runtime.ctx` "Plain holder" 模式。
2. **方法脱绑定**：`const f = session.append` 在 ESM 严格模式 `this === undefined` → `Reflect.apply` 绑定调用。
3. **scoped world**：`createScope(ctx, agent)` + `scope.ctx.extend({ agent })`——controller 的 setup 契约（`agentCtx.agent`、presets 的 scope key）。
4. **dsh-scope 双实例 symbol**：`kScope = Symbol("dsh.scope")`（非 `Symbol.for`）——第二份包副本 mint 不同 symbol，宿主 agent-presets 看不见我们的 scope。修复：运行时从宿主进程（`argv[1]` realpath）解析 dsh-scope 模块实例，失败回落本地（单测环境）。cordis 系 symbol 全用 `Symbol.for`（跨实例安全，不受影响）。
5. **生命周期归属**：session/agent 的 enter 与 lifecycle effect 注册在**插件 ctx**（`agent.ctx`/`svcCtx`），不在 `ownerCtx`（请求域）——请求结束解绑导致会话脱钩、50ms 后的轮次 append 派发不出 `session/event`、不落盘、且每次 prompt 重复 resume。

## 用户验收

实例保持运行（`m1-4998-test`，0.0.0.0:4998）——token URL 交用户浏览器实测。

## 已知缺陷细节（M1.1 输入）

- 现象：重启后对已有 echo 会话首建 agent（resume 路径），turn 事件只进内存（`ownEvents` 增长），文件冻结；同实例 create 路径完全正常。
- 已排除：事件未派发（echo ctx 监听器收到全部轮次事件）、writer 未注册（`writers.get(id)` 命中、`buffered=0`、`drainPaused=false`）、handle 提前关闭（lifecycle disposer 未触发）、batch 延迟（200ms 常量）、双 backend 实例（dump 单行）、文件轮转（目录单文件）。
- 直写通道可用：resume 的 closers 经 `handle.append` 成功落盘（4bc 实验 +2 行）。
- 候选方向：backend `install()` 监听器对 restored-session 事件的接收路径；或以显式 suffix flush（上游 `appendUnstoredSuffix` 模式）绕开 live routing（需防与 create 路径 live routing 双写）。
