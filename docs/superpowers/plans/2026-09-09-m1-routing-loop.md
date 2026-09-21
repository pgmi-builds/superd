
> **【状态：随方向搁置（SHELVED）2026-09-10】** M1 路由循环 已按计划完成并通过验收，但上层方向（multi-agent registry 路线）经 2026-09-09/10 实测判定服务面无法隔离而搁置；本计划及其产物转入维护模式，不再演进。见 `docs/02-dsh/multi-agent-registry.md` 顶部状态。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 M0 占位的 MultiAgentRegistry 上打通**运行期路由闭环**：`appendFactory('echo', …)` 一个 echo Agent Loop，per-session runtime 键一条规则（`header config.runtime ?? 'native'`），RPC 切换，验收"运行期切到 echo / 切回 native，无重启、无重载、无任务死亡"。

**Architecture:** registry 层保持单一职责分流阀 + 万物透传管道（管道原则入 spec 约束）。echo provider 是第一个 ForeignAgent：`ExternalAgentBase` 最小 Agent 脸（mint 合规 session + 回声事件），不 spawn 进程。UI chip 不在本计划（RPC + curl 验收即闭环；chip 连同 client 半构建链另立 M1b/M2，YAGNI）。

**Tech Stack:** 沿 M0（TS + tsc、node:test、fake-ctx 单测、`.superd-test` profile、systemd-run 拉起、用户验收模式）。

**Spec:** `docs/02-dsh/multi-agent-registry.md`（§三/§四 展开；本计划同时把管道原则与键规则写回 spec）

## Global Constraints

- 上游源码零修改；`upstream/deepseek-harness` 只读。
- `DSH_HOME=.superd-test`；绝不碰 `~/.dsh`、`~/.superd`；测试凭据只从 `~/.dsh` 只读复制（M0 先例）。
- 实例 `systemd-run --user` 拉起、bind `0.0.0.0`、**验收模式**：起服即交用户保持运行，不自行 kill（AGENTS.md §三 dsh-plugin 线契约）。
- **管道原则（本计划新增 spec 约束）**：registry 层禁止检查/改写任何非 runtime 字段；create/resume 对 options 全量透传。
- cordis Service 子类禁止 `#` 私有成员（M0 教训，已入 README/记忆）。
- 每任务独立 commit；npm publish 不在本计划。

---

## File Structure

```
packages/dsh-multi-agent-registry/
├─ src/
│  ├─ index.ts          # MultiAgentRegistry：+ symbols.original 规范化、resolve 读键
│  └─ routing.ts        # 键读写：readKey(sessionId) / writeKey(sessionId, key)（新，从 index 拆出）
├─ test/
│  ├─ registry.test.mjs # 扩展：original 剥壳、键路由命中
│  └── routing.test.mjs # 键存储读写/降级
packages/agent-loop-echo/               # 新包：echo ForeignAgent
├─ src/{index.ts,external-agent.ts}    # appendFactory('echo') + ExternalAgentBase 最小实现
├─ test/echo.test.mjs
├─ cordis.patch.yml                    # insert 行（mount echo loop）
└─ package.json / tsconfig / README
scripts/m0-profile.mjs                 # bundles 加 agent-loop-echo
docs/02-dsh/multi-agent-registry.md    # spec 增补（管道原则/键规则/echo as-built）
```

---

## Task 1：spec 增补——管道原则 + 键规则定案

**Files:** `docs/02-dsh/multi-agent-registry.md`

- [ ] §四路由键一节重写为定案形态：**一条规则 `runtime = header config.runtime ?? 'native'`**；写路径 = 插件 RPC；旧会话无字段 → native（降级语义）；键粘性问题显式裁决：键只在投递边界读取（delivery-time），每次 create/resume 现读现判，不做 lastUsed 类粘性缓存。
- [ ] 新增"管道原则"约束小节：registry 层唯一职责 = 分流决策；禁止检查/改写任何非 runtime 字段；`options` 经 `Reflect.apply` 原样透传（引用同一性）。违反即为设计缺陷。
- [ ] commit：`m1: spec — pipe principle + single routing-key rule`

## Task 2：调研 spike——header `config.runtime` 的可行性与写路径

**性质：调查任务，产出 = spec 勘注 + 裁决，不改包代码。**

- [ ] 读 `upstream/deepseek-harness/packages/core/session`（`request/header` 事件 schema、config 字段校验 strict/passthrough）与 `api/session-controller`（何时触发 `agents.create/resume` 相对 prompt 的时序）。
- [ ] 查 header config 的运行期写通道：是否存在 API/service 可写（`session.rename` 同级的 header 写面？）；若无，评估两退路并裁决：(a) registry 自管旁路表（M0 报告方案，插件目录原子 JSON）；(b) 经 `sessionPersistence` 自写事件。裁决标准：哪个不改上游语义、迁移最简单。**预期默认：旁路表**（键不随 session log 迁移的代价已知并接受，spec §四已记录）。
- [ ] 裁决与证据写进 spec §四勘注；commit：`m1: routing-key investigation — <裁决>`

## Task 3：registry——symbols.original + 键路由 + routing.ts

**Files:** `packages/dsh-multi-agent-registry/src/{index.ts,routing.ts}`、`test/*.mjs`

- [ ] `append`：`const target = factory[symbols.original] ?? factory`（M0 遗留 known-boundary 清账）。
- [ ] 拆 `routing.ts`：`readKey(sessionId): string | undefined`（Task 2 裁决的存储后端）+ `writeKey`；原子写、miss 降级注释。
- [ ] `resolve(sessionId)`：`factories.get(readKey(sessionId) ?? 'native')`，仍 miss 时优先 native 兜底还是 throw——裁决并注释（倾向：显式注册过的键失效 → 回落 native + warn，不炸投递）。
- [ ] 单测：original 剥壳（构造带 `[symbols.original]` 的 fake）、键命中/miss 降级、writeKey→readKey 回读、管道原则守护测试（options 引用同一性断言，防未来回归）。
- [ ] `node --test` 全绿；commit：`m1: registry — original canonicalization + key routing`

## Task 4：agent-loop-echo 包——第一个 ForeignAgent

**Files:** `packages/agent-loop-echo/**`

- [ ] `ExternalAgentBase`（`external-agent.ts`）：实现 Agent 脸最小集——`options/session/inbox/status/ctx` + `send/steer/inject/followup/cancel/whenIdle/runMaintenance` + `agent/status` 事件；`createAgent/resume`：经 `sessions`/`sessionPersistence` 面 mint 合规 session（header + `permission/preset`、`sandbox/mode` 等最小必填集——以 M0 实测 session log 事件序列为模板）；`followup` 驱动一轮：`user/message` → （异步小延时）→ `assistant/message`（回声原文）→ `turn/end: completed`。
- [ ] `index.ts`：`inject ['agents']`，`ctx.agents.appendFactory('echo', …)`；**绝不调用 setFactory**。
- [ ] `cordis.patch.yml`：一行 `insert {id: agent-loop-echo, name: '@pgmi-builds/dsh-agent-loop-echo'}`。
- [ ] 单测（fake-ctx + fake sessions 面）：注册命中 echo 键、followup 产生回声事件序列、cancel/whenIdle 行为。
- [ ] 包骨架沿 M0 形态（optional peers、.npmrc、README 含 type-wiring 引导）；commit：`m1: agent-loop-echo — first ForeignAgent (echo)`

## Task 5：RPC 面 + profile 并线

**Files:** `packages/dsh-multi-agent-registry/src/rpc.ts`（或 echo 包内，裁决：跟 registry 走——键是 registry 的职责面）、`scripts/m0-profile.mjs`

- [ ] `ctx.webServer.register`（prefix 路由 `/api/agent-runtime`，命名避开上游 `/api` RPC 面）：`GET ?sessionId=` 返回当前键与可用键列表；`POST {sessionId, runtime}` 写键。
- [ ] `scripts/m0-profile.mjs`：bundles 追加 `@pgmi-builds/dsh-agent-loop-echo`（link: 同款）；重建 profile 树。
- [ ] `--dump-config` 核行表（agent-loop-echo 行存在、agent/agent-multi/agent-loop 三行不变）；commit：`m1: runtime-key RPC + echo loop mounted`

## Task 6：4998 实例集成验证（controller 第一人称）→ 用户验收

- [ ] `systemd-run --user` 拉起（AGENTS.md 契约，0.0.0.0）。
- [ ] controller 冒烟：新建会话（native）发消息一轮正常；RPC 查/切 `echo`；同会话或新会话下一条消息走 echo（session log 出现回声 assistant/message）；RPC 切回 `native`，再发消息回原生（zai-plan 真实回复）；**全程进程不重启、WS 不断、切换期间 native 在飞任务（长指令）不被打断**——这是 seam §5.3 行为保证的直接验收。
- [ ] resume 验证：重启实例后 echo 会话 resume 仍路由 echo（键持久生效）。
- [ ] **交用户验收**：token URL + 内网地址交出，保持运行，等确认。
- [ ] commit（如有修复）。

## Task 7：测试报告 + spec as-built

- [ ] `docs/test-reports/2026-09-09-m1-routing-loop.md`：切换矩阵（native↔echo）、行为保证四条逐项证据、用户验收记录。
- [ ] spec §七 M1 打勾 + as-built 注记；ledger 收尾。
- [ ] commit：`m1: test report + as-built`

---

## Verification (plan-level)

M1 判定：**运行期切换是数据写入**——RPC 改键后下一条消息投给对应 loop，进程/WS/在飞任务零影响；echo 会话在 Web UI 完整可读（回声渲染）；重启后键持久。UI chip 明确 out of scope（M1b/M2）。

## Out of Scope

- UI selector chip 与 client 半构建链（M1b/M2）
- OMP / PI / Claude Code 真 provider（M2+）
- npm publish
