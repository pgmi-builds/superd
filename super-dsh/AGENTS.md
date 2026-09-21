# super-dsh — 局部规则（Agent Worlds 第三路线）

- 本文件管辖本目录及子目录；上层为仓根 `AGENTS.md`（最近者胜，中间无其他层）。
- 第三路线：Multi-Context 拓扑 × M0-Fork 数据面哲学的融合线（foreign agent deep integration and detachment）。设计正本：`docs/superpowers/plans/2026-09-14-agent-worlds-fusion-design.md`（S1–S6 裁决）；现役实现计划：`docs/superpowers/plans/2026-09-14-agent-worlds-aw-a-plan.md`。
- **Agent Adapter 开发规则（必读）**：`agent-adapter-dev-rules.md`（本目录）——adapter 定位/两形态/测试准则/接线域、per-agent 定制权、home 与 profile 布局（`$DSH_HOME` / `agents/<label>` / `profiles/<label>`）、通用纪律。新写或改动任何 `agent-adapter-*` 前先读它。
- 本线 adapter 记录：`docs/superpowers/plans/2026-09-15-agent-worlds-agent-codex-adapter-plan.md`（AW-E 计划）、`docs/superpowers/plans/2026-09-15-agent-codex-4985-acceptance-report.md`（实现与验收实录）。
- **agent-pi adapter（AW-F，2026-09-17）**：`agent-pi/`（`@pgmi-builds/agent-adapter-pi`，in-process `@earendil-works/pi-coding-agent` SDK，无 sidecar）。**per-adapter home 裁决（2026-09-17 user）**：pi 运行时数据保持**原生 `~/.pi`**（不建 app home、不重定向 `PI_CODING_AGENT_DIR`——dev-rules §5/§13 对 pi 的运行时数据不适用）；`<dshHome>/agents/pi/` 只放 adapter 自己的 DSH 态（`dsh-sessions.json` 映射）；会话双份存储显式接受。记录：`docs/superpowers/plans/2026-09-17-agent-pi-adapter-plan.md` + `2026-09-17-agent-pi-adapter-acceptance-report.md`。**坑**：本包 `npm install` 会把 `file:../agent-hub` 物化成物理副本（hub 双实例 → 世界 webServer 全 pending），装完必须重链 symlink（见包 README）。
- 本线记录：`docs/superpowers/plans/2026-09-16-compaction-tuning-native-only-acceptance-report.md`。**范围裁决（2026-09-16 user）**：本线纯粹是 multi-agent 功能，**不涉及 Native Dash Runtime 的 functionality**（compaction 等）——那属于 Dash 开发项目的 shipment 范畴；曾为验证 WebUI 世界分隔而临时挂入的 compaction-tuning 探针包**已拔除删除**。**留存结论（活体分隔证据）**：设置行只在原生 DSH WebUI 渲染、omp / codex 世界 UI 连节点都没有（该世界 ctx 未 compose 此 bundle → namespace 不在 → 行画 null）——同一浏览器壳、同一认证域，UI 内容按被寻址世界的 composition 投影，即**世界分隔连 WebUI 层也成立**（§4.1 + §12；证据细节见该报告，机制不可作为本线新增 native 功能的理由）。
- 姊妹线 `archive/multi-agent/`（2026-09-10 搁置）、`archive/multi-agent-ctx/`（冻结保留；2026-09-22 仓重排 apps/ 退役，姊妹线迁入 `archive/`）——**拷贝或引用，永不反向依赖；冻结线永不因本线被迫改动**。

## 职责分界（2026-09-14 定案）

- cordis/dsh patches（UI 或后端）、存储适配、adapter runtime **一律 per agent**（`agent-adapter-*` / `agent-ui-*` 包自持）。
- **本线自身只建设 switch 与 gateway**：`agent-hub/`（selector + V5 实例委托导流门 + roster + spawnWorld）。mostly, at least now；adapter 专属物永不上提到线。

## 核心不变量（违反即设计缺陷，详见设计文档 S1–S6）

1. **S1**：selector 一跳 handoff；dispatcher 从不在请求路径寻址 sessionId；错误 sessionId 由当前世界 sessionController 独占应答（原生 not-found 语义），零跨 context 探测。
2. **S2**：roster = adapter 插件加载态投影，无配置文件；spawn 由插件自带 composition（引用上游 bundle 名）在 CTX0 树上 `boot()` 派生——**绝不经 `runProfile()`**（ADR 0008 约束 1）。
3. **S3/S7**（2026-09-17 改版）：`<dshHomePath>/agents/<runtime>/` = 该 agent world 的 **DSH home**（DSH 会话日志副本、storages、adapter 自有 DSH 态）；native app 数据留在**原生 home**（`~/.omp` / `~/.codex` / `~/.claude` / `~/.pi`），spawn 零重定向、零 config 拷贝；原生 session log 留原生格式，DSH log（AW-C1 起）与之 duplicate 显式接受；单向阀 = 不回读。
4. **S4**：零端口 ctxN（不喂 bind 参数 / disable web 行）；委托 = `typertGateway` 实例两方法进程内委托，零 HTTP、零字节代理；单一认证域（ctx0 cookie）。
5. **S5**：行表深度 agent-specific；omp-web 形态起步不 suppress `ctx.llm`；数据路径归 adapter 所有；会话 log 单一主笔仅在采纳转译（AW-C1）时为准入判据。
6. **S6**：router 是哑的——只管 consumer 切换 + 新会话 generator 指向；生命周期归 owner context；零 HMR / 零 Drain。

## 运维红线

- 上游源码零修改；`@deepseek-ai/*` 单实例纪律——任何 install 后 `find <scope>/node_modules/@deepseek-ai -maxdepth 1 -mindepth 1 ! -type l` 检查（2026-09-22 housekeeping：仓根 `node_modules` farm 已删除；现存 scope = `.tests/profiles/node_modules/@deepseek-ai`，指向 repo build）。
- DSH 侧 dev/test 一律 `DSH_HOME=<仓根>/.tests`（agent world DSH home = `$DSH_HOME/agents/<label>`、agent profile = `$DSH_HOME/profiles/<label>`；foreign runtime app home = 原生 `~/.omp` / `~/.codex` / `~/.claude`，spawn 不重定向——见 dev-rules §5/§13；`<仓根>/.tests/aw` 是历史线 home）；**绝不触碰 `~/.dsh`、`~/.superd`（DSH prod home）**。
- **agent-omp 的 OMP home 属 adapter 级自由**（2026-09-15 user 裁决保留）：`OMP_HOME` env 重定向仍是 adapter 的可选项（隔离微调），但**默认已改为原生 `~/.omp`**（2026-09-17 裁定，见 dev-rules §5）。
- 端口 4998（本线默认）；**4999 = 本线共用测试口（2026-09-16 user 裁决，接替已冻结的 multi-agent-ctx；Caddy `test.pc.randomhash.app` → 127.0.0.1:4999，WAN 可见，同一时间只能一条线占用）**；避开 3080/3081（prod）；拉起前 `ss` 预检；daemon 一律 `systemd-run --user`，关停 `systemctl --user stop`。当前 4999 在役 unit：`aw-4999-test`（`test/start-4999.sh`，见 2026-09-16 验收报告）。
- 测试约定：`node --test test/*.test.mjs`；测试导入 `dist/`，先 build 后 test。
