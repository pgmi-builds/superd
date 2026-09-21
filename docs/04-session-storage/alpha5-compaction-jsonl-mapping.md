# Alpha.5 Compaction 在 Session JSONL 中的实测测绘

> 2026-09-04 · 实证样本：prod `~/.dsh/sessions/--home-u1-workspaces-dashr--/session-788be2e1-eb38-4d9a-b3cf-a22d148af1f6/session.jsonl.zstd`（35,555 行，seq 跨度 0..337,997，cwd=本仓库，agentPreset=standard，glm-5.3，contextWindow 1M）。
> 该会话含 **2 次成功压缩 + 1 次失败压缩**（均为用户手动 `/compact`，`command/run source={kind:'user'}`），是 alpha.5 存储格式下最完整的压缩剧集样本。
> 关联设计：`docs/10_plans/recallable-compaction.md`（2026-08-20，基于 alpha.3 契约）。**本文档即该设计的 alpha.5 事实刷新。**

## 0. 存储格式变更（先于一切的坑）

- 文件名从 `*.jsonl` 变为 **`session.jsonl.zstd`**（整文件 zstd 单流，`zstd -dc` 直接解开为 JSONL）。文本 grep 全部落空，必须先解压。
- 目录布局：`sessions/<cwd-改写目录>/<session-id>/session.jsonl.zstd`。
- **seq 与 log 行号彻底分离**（alpha.5 内部破坏性重构，见 `docs/50_test-reports/upstream-dsh-0.1.2-alpha.5-report.md`）：本样本 35,555 行但 seq 最大 337,997，且 seq 有大段空洞（7,8,9,10,504,…）。**任何寻址实现都必须整文件解析建 seq→event 索引，不能按行号推算。**

## 1. 一次成功压缩的事件链（五连拍，seq 严格相邻）

以 EPISODE-2（compactionId `0e2d4a6c-…`）为例：

| seq | 事件类型 | 角色 |
|---|---|---|
| 221215 | `command/run` | 触发：`{commandId:"cmd-32ef6997-3", name:"compact", args:"", source:{kind:"user"}}` |
| 221216 | `compaction/start` | log-only 开始标记：`{compactionId, sourceCommandId, turn:null}` |
| 221217 | `compaction/summary` | **索引金矿**（§2） |
| 221218 | `user/message` | **checkpoint 节点**：surface 上替换旧区间的摘要消息（§3） |
| 221219 | `compaction/end` | log-only 结束标记（失败时带 `error` 字段） |
| 221220 | `command/done` | `{kind:"success", text:"Compacted 559 history items (~347901 tokens).", sourceEventSeq:221217}` |

checkpoint 节点 = summary seq + 1（**contractual adjacency 在 alpha.5 依旧成立**，两次 episode 均验证）。

## 2. `compaction/summary` 事件字段全集（log-only，模型不可见）

```
data: {
  compactionId:        "0e2d4a6c-a47a-464e-b3f8-dc2e2bb12a23"   // UUID
  sourceCommandId:     "cmd-32ef6997-3"
  summary:             [{type:'text', text:'## Primary Request and Intent\n…'}]  // 结构化 checkpoint 正文
  rawOutput:           [{…},{…}]                                 // 摘要模型原始输出块（含 reasoning）
  llmStreamCall:       true
  shadowedRange:       {start: 109246, end: 220120}              // seq 区间（含端点）
  shadowedSeqs:        [109246, 109240, 109257, …]               // 559 条，被压缩的 surface 条目 seq
  shadowedTokenCount:  347901
  provider / model / maxTokens / usage: {…}                      // 摘要调用计量
}
```

对比 2026-08-20 备忘（alpha.3 契约）：`shadowedSeqs` **仍然存在**，且新增 `shadowedRange`（区间式）、`shadowedTokenCount`、`rawOutput`、完整 `usage`。`CompactionResult.summarySeq` 字段未再出现，但「checkpoint = summary+1」邻接关系可替代。

## 3. checkpoint 节点（surface 唯一可见物）

`user/message`（seq 221218），三段式 content：

```
[0] 固定指令前缀（英文）: "This is an automatically generated checkpoint condensing an
    earlier span of the conversation to free up context. Treat the captured context as
    established background … without acknowledging this checkpoint.\n\n<compacted-summary>"
[1] 摘要正文（## Primary Request and Intent … ## Critical Context，共 8 段，12.5K chars）
[2] "</compacted-summary>"
```

元数据（模型不可见）：
- `source: {kind:'plugin', plugin:'compact', compactionId, sourceCommandId}` —— **compactionId 在这里**；
- `sourceEventSeqs: [221216, 221217, …shadowedSeqs 全量]`（= 两个 compaction 事件 + 全部被压缩 seq，561 条）；
- `surfaceOp: {op:'replace', start:109246, end:220120}` —— **这就是"从哪里开始旧上下文不再加载"的标记**：surface 投影把 [start..end] 区间折叠为本节点，log 一字不删。

## 4. 关键判定：identifier 是否 surface 给模型？

**否，逐字节验证过。** checkpoint 可见文本（12,880 chars）中：无 compactionId、无任何 `ctx-`/`recall`/标签/handle。可见部分只有固定前缀 + `<compacted-summary>` 包裹的 8 段摘要。compactionId 仅存在于 log-only 事件与 `source` 元数据。

**结论：连展示标签的地方都不能省——必须由我们挂标签**（沿用旧设计：单节点 replace 在 checkpoint 尾部追加标签行，或走 ctx:// 清单入口，见 §7）。

摘要 8 段 schema（`dsh-compaction-basic` COMPACTION_INSTRUCTION，实测两次 episode 一致）：
`## Primary Request and Intent / Key Technical Concepts / Files and Code / Errors and Fixes / Pending Jobs / Current Work / Next Step / Critical Context` —— 即用户所说"目的 / user 说了什么 / 结果 / 状态"的官方形态。

## 5. 嵌套压缩与失败压缩

- **嵌套链**：EPISODE-2 的 `shadowedRange.start = 109246` 恰是 EPISODE-1 的 checkpoint 节点——第二次压缩把**上一次的 checkpoint 也收编了**。EPISODE-1 的原文（seqs 7..108714，499 条）仍完整躺在 log 里，经 EPISODE-1 的 `compaction/summary.shadowedSeqs` 可达。log 永不删除 ⇒ **链式全 history 均可寻址**，只是要按 episode 分档。
- **失败压缩也留痕**：`cmd-32ef6997-2` 的 `compaction/end` 带 `error: "summary is not smaller than the shadowed content (2470 estimated framed tokens >= 2463)"`，且**没有** summary 事件和 checkpoint 节点。索引构建时必须过滤（只收"有 checkpoint 后继"的 episode）。
- shadowedSeqs 只含 **message 级事件**（本 episode：292 tool/result + 243 assistant/message + 24 user/message + 上次 checkpoint），chunk 噪音（reasoning-chunks/text-chunks/assistant/chunk）天然不入档。

## 6. 对 ctx:// 设计的直接输入（用户 2026-09-04 方向）

1. **数据源现成**：一次 JSONL 解析（zstd 解压 → seq 索引）即可在内存重建全部可寻址条目：每个成功 episode = `compactionId + shadowedRange + shadowedSeqs + shadowedTokenCount + 摘要正文 + 时间戳`。无需 host API、无需压缩前拦截、无需 kernel 变量。
2. **二级/三级寻址可行**：`ctx://compacted/` → 返回清单（label + 时间 + token 量 + 摘要首段预览，供模型判断"要不要调"）；`ctx://compacted/{label}` → 按 shadowedSeqs 逐条 derive 出原文（role+content）返回。label 建议短形（按序 `1`,`2`…或 compactionId 前 8 位），清单里同时给全 UUID 以备精确引用。
3. **read 万能工具承载**：read 已支持 scheme:// 解析（skill/agent/dsh/dvc/http 先例），kernel 内外桥接同构，符合"不加 kernel 变量、不重复角色"的裁决。
4. **崩溃重建 = 重读重解析**：JSONL 即持久层，符合"归档只是快路径缓存"的旧结论（本样本中连缓存都不需要，直接读 log）。
5. **lazy/eager**：索引（episode 级，个位数条目）可 eager；原文内容（34 万 token 级）必须 lazy——按 label 解引用时才沿 shadowedSeqs 取。
6. **挂标签通道不变**：若仍想在 checkpoint 尾部留一行 `ctx://compacted/2` 级别的提示，alpha.3 验证过的单节点 replace 机制在 alpha.5 事件结构下依旧适用（surfaceOp replace 即官方改写机制本身）。

## 7. 与 2026-08-20 备忘的差异清单

| 项 | alpha.3 备忘 | alpha.5 实测 |
|---|---|---|
| 存储 | `*.jsonl` 明文 | `session.jsonl.zstd`，seq↔行号分离 |
| `shadowedSeqs` | 在 `compaction/summary` | **仍在**，且新增 `shadowedRange`/`shadowedTokenCount` |
| `CompactionResult.summarySeq` | 存在 | 未见；以「checkpoint = summary seq + 1」邻接替代 |
| 摘要形态 | 8 段 checkpoint | 不变（8 段，实测两次一致） |
| checkpoint 可见文本 | — | 固定前缀 + `<compacted-summary>` XML 包裹；**无任何标识符** |
| 失败压缩 | — | start/end 留痕带 `error`，无 summary/checkpoint；索引需过滤 |

## 8. 复现命令

```bash
zstd -dc ~/.dsh/sessions/<cwd-dir>/<session-id>/session.jsonl.zstd > /tmp/s.jsonl
jq -c 'select(.type | startswith("compaction/"))' /tmp/s.jsonl        # 事件链
jq -c 'select(.data.source.compactionId != null)' /tmp/s.jsonl        # checkpoint 节点
```

---

## 9. 压缩剧集 JSON 原文（逐字截取，2026-09-04 增补）

机器可读样本（供其他 Agent / 工具直接调用）：

- `docs/60_exploration-and-research/04-session-storage/alpha5-compaction-sample/episode1.json` —— 首次成功压缩（seq 109243-109248，shadowed 7..108714，499 items / 219,341 tokens）
- `docs/60_exploration-and-research/04-session-storage/alpha5-compaction-sample/episode2.json` —— 第二次成功压缩（seq 221215-221220，shadowed 109246..220120，559 items / 347,901 tokens，本文分析对象）
- `docs/60_exploration-and-research/04-session-storage/alpha5-compaction-sample/episode-failed.json` —— 失败压缩（seq 109249-109252，error: summary 不小于原文）

EPISODE-2 五事件完整原文（pretty-print，数组未删减）：

```json
[
 {
  "type": "command/run",
  "seq": 221215,
  "time": 1788391782256,
  "data": {
   "commandId": "cmd-32ef6997-3",
   "name": "compact",
   "args": "",
   "source": {
    "kind": "user"
   }
  }
 },
 {
  "type": "compaction/start",
  "seq": 221216,
  "time": 1788391782272,
  "data": {
   "compactionId": "0e2d4a6c-a47a-464e-b3f8-dc2e2bb12a23",
   "sourceCommandId": "cmd-32ef6997-3",
   "turn": null
  }
 },
 {
  "type": "compaction/summary",
  "seq": 221217,
  "time": 1788391831672,
  "data": {
   "compactionId": "0e2d4a6c-a47a-464e-b3f8-dc2e2bb12a23",
   "sourceCommandId": "cmd-32ef6997-3",
   "summary": [
    {
     "type": "text",
     "text": "## Primary Request and Intent\n- Execute OpenSpec change `2026-09-03-plugin-shipped-ui-patches` (v0.2.1f): ship the two \"user requested\" UI patches WITH the better-dsh plugin instead of local patching — (P2) loopback auth / provider-directory fix, (P3) mobile responsive sidebar + swipe gestures.\n- User verified results and gave three rounds of corrections. Round 3 (current): user tested from phone AND MacBook via **`test.pc.randomhash.app`** (NOT the socat 4990 URL I gave) — Models page still broken there. User demands: (a) CHECK THE SERVER LOGS before claiming which instance/hostname the user hit; (b) use remote agents (Hermes on another machine, or OMP on DEV3) to do real browser tests instead of trusting my own headless-chrome probe; (c) answer the mutability question: is `__DSH_TRANSPORT__`/`isLoopback` read ONCE at apply time (a one-shot constant) or re-evaluated per call — because if the client bundle loads last, the variable may already be patched by the time anyone inspects it.\n- User instruction (standing): swipe/move detection must reference sidecarx implementation (done round 3: sidecarx has NO velocity gate; aligned defaults 50px/40px band/velocity 0).\n- Earlier standing rulings: never suggest upstream PRs (upstream closes all PRs); never summarize better-dsh as \"just a REPL\"; Route A (127.0.0.1 direct access) rejected because the requirement is OTHER-device access.\n\n## Key Technical Concepts\n- **Boot-script mechanism (P2 isLoopback leg)**: host half listens public event `webserver/index-inject` → pushes inline `{kind:'script',placement:'head',text}` into served HTML → runs before any application bundle materializes → sets `window.__DSH_TRANSPORT__={ownsHost:true}` → connection client `apply()` computes `isLoopback` **once at apply time** (source: `packages/client/connection/src/client/index.ts:228` — property on handle literal, evaluated when browser cordis applies the plugin; NOT re-read per call). Delivery vehicle is server-rendered HTML; the variable is a frontend runtime global read by `dsh-client-connection`'s browser half.\n- **P2 fence leg**: bundle patch overrides `connection` row in `dashr/cordis.patch.yml` (whole-row restatement; `!!js` is a **scalar tag — expression must NOT start with `[`**, use `(…).concat(…)` form): `trustedHosts: !!js (process.env.DSH_TRUSTED_HOSTS ?? '').split(/\\s+/).filter(Boolean).concat(ctx.webRuntime.trustedHosts)`.\n- **P2 root cause (settled)**: `ui-settings` reads `ctx.remote.$host.isLoopback` once at apply → non-loopback = `'memory'` persistence = \"terminally unavailable, never touches the wire\" → Models page fails with \"settings are unavailable in this browser\". Upstream design note `2026-08-06-host-backed-web-preferences.md` shows intent was \"preferences remain process-local\" (page works) — mirror over-tightened it; trustedHosts concept never propagated to host facts.\n- **Mobile gestures (round-3 aligned to sidecarx)**: `classifySwipe(sample, thresholds, panels)` panel-aware: left collapsed→rightward from left band opens; left expanded→leftward from ANY origin closes; details closed→leftward from right band opens; details open→rightward (not from left band) closes. Panel state read from AppFrame attrs (`[data-sidebar-collapsed]`/`[data-details-collapsed]` absent = expanded). Defaults: distance 50, edgeBand 40, **velocity 0 (disabled — sidecarx parity)**, breakpoint 1024. touch/pen only, `|dx|>|dy|` required.\n- Client-half config channel: `window.__DASHR_MOBILE__` page global set by same boot script (client bundle gets NO loader config).\n- 4999 test topology: daemon `systemd-run --user --unit=dsh-4999-test` (binds 127.0.0.1 only; `--host 0.0.0.0` deliberately refused by launcher: \"would expose remote code execution\"); socat user unit `dsh-4999-lan` (0.0.0.0:4990→127.0.0.1:4999); env via `EnvironmentFile=.scratch/dsh-4999.env` (`DSH_TRUSTED_HOSTS=probe.example 192.168.31.130`); profile patch at `.dsh-test/profiles/web/cordis.patch.yml` sets `trustedPageAuthorities: ['probe.example','192.168.31.130']`.\n- **NEW unresolved**: user accesses via `test.pc.randomhash.app` — a hostname NOT in trustedPageAuthorities (only `probe.example`, `192.168.31.130`) → boot script does NOT flip ownsHost for it → isLoopback stays false → Models fails. Also `test.pc.randomhash.app` must resolve/proxy to 4999 somehow (unknown — Caddy edit forbidden without approval; DNS/Caddy routing for test.* unverified). MUST check `.scratch/dsh-4999.log` + Caddy config to see what actually happened.\n- CDP probe: `.scratch/cdp-probe.mjs` (ws@8.21.0 from monorepo `.pnpm`; chrome must run via systemd-run user unit `dsh-cdp-chrome` — killed inside sandbox exit 143). Verified via 192.168.31.130:4990: `__DSH_TRANSPORT={ownsHost:true}`, Models renders \"DeepSeek / Edit / Add provider\". User challenges probe reliability — wants cross-machine verification via Hermes/OMP agents (A2A: `mcp__cordis-a2a__a2a_send` to Hermes; DEV3 OMP via a2a too).\n- `dsh-better-sidebar`: 0.17.1 incompatible with alpha.5 (`settingsNamespace` export removed); 0.18.0-alpha.0 installed OK; install = `dsh plugin --profile web add --config.auto-install-peers=false <pkg>`; profile pnpm-workspace needs `allowBuilds: node-pty: true` + `pnpm rebuild node-pty`.\n- RPC replay for diagnosis: `POST /api/<ns>/<method>`, body `{\"type\":\"client-request\",\"rpcId\":\"x\",\"method\":\"<ns>/<method>\",\"payload\":{\"args\":{}}}` — slash namespacing.\n\n## Files and Code\n- `dashr/src/web-trust.ts` (NEW, host half): `buildBootScript(config)` pure fn + `installWebTrust(ctx, config)` — `webserver/index-inject` listener; script sets `__DSH_TRANSPORT__` (no-overwrite guard, JSON-embedded authorities, `{ownsHost:true}` only) + `__DASHR_MOBILE__`; mobile default-ON; malformed authority (port/path/empty) throws `/bare hostname/`.\n- `dashr/src/mobile/gesture.ts` (NEW, pure): `classifySwipe`, `isInteractiveOrigin`, `isNarrowViewport`, `resolveMobileConfig`, `DEFAULT_SWIPE_THRESHOLDS={breakpoint:1024,swipeDistancePx:50,swipeVelocityPxPerMs:0,edgeBandPx:40}`; velocity gate only when `>0`.\n- `dashr/src/mobile/client/index.ts` (NEW, client half): `setupMobileLayout(ctx)` — style tag (`data-plugin`/`data-plugin-css='@pgmi-builds/better-dsh/mobile'`, media query `[data-sidebar-collapsed]{grid-template-columns:0px minmax(0,1fr) 0px !important}`), pointer listeners → `classifySwipe` → `toggleSidebar()/openDetails()/closeDetails()`; `ctx.inject(['layout'],…)` conditional.\n- `dashr/src/index.ts`: Config += `trustedPageAuthorities?: string[]`, `mobile?` (schema via `MOBILE_CONFIG` const; whole schema cast `as unknown as z<Config>` for schemastery intersect inference); apply += `installWebTrust(ctx, config)`.\n- `dashr/src/failover/client/index.ts`: client entry mounts `setupMobileLayout(ctx)`.\n- `dashr/cordis.patch.yml`: += connection row override (fence leg).\n- `dashr/package.json`: version `0.2.1-f`; `dsh.client.inject` += `@deepseek-ai/dsh-client-ui-layout`.\n- `dashr/tsconfig.json`: exclude += `src/mobile/client` (client-half convention).\n- Tests: `dashr/test/web-trust.spec.ts` (8), `dashr/test/mobile-gesture.spec.ts` (10) — 429/429 total.\n- `.scratch/cdp-probe.mjs`, `.scratch/dsh-4999.env`, `.scratch/models-page-proof.png` (screenshot proof).\n- `.dsh-test/profiles/web/cordis.patch.yml`: dashr-repl row override w/ trustedPageAuthorities (currently `['probe.example','192.168.31.130']` — **missing `test.pc.randomhash.app`**).\n- `docs/50_test-reports/v0.2.1f-plugin-shipped-ui-patches实测报告.md`: rounds 1-3 appended.\n- OpenSpec change dir + skill `.agents/skills/dsh-plugin-development/` + AGENTS.md §四 — all updated through round 3.\n- Reference: `~/workspaces/sidecarx/src/webclient/src/app.js:332` (SWIPE_THRESHOLD=50, band 40, no velocity), `components/overlay-viewer.js:226`.\n\n## Errors and Fixes\n- `!!js` leading-`[` → YAML flow-seq rejection: use `(process.env.X ?? '').split(/\\s+/).filter(Boolean).concat(ctx.webRuntime.trustedHosts)`.\n- Duplicate Config schema blocks from edit collisions in `src/index.ts` (twice) + missing `swipeDistancePx` line: fixed by careful re-reads.\n- Headless chrome killed in sandbox (exit 143): run via systemd-run user unit outside sandbox.\n- `--host 0.0.0.0` refused by launcher (intentional upstream safety): socat LAN proxy instead.\n- `systemd-run` with spaced env value → \"Invalid environment block\": use EnvironmentFile.\n- Left-swipe-to-close never fired (round 2): root cause = origin edge-band-only condition rejected swipes starting on the overlay body; fixed with panel-aware classifier (expanded→any origin).\n- Velocity 0.35 \"too fast\" (round 2) → 0.2; round 3 → sidecarx has NO velocity gate → default 0.\n- better-sidebar 0.17.1 crash on alpha.5 (`SyntaxError: ... does not provide an export named 'settingsNamespace'`) → 0.18.0-alpha.0.\n- **User round-3 corrections (unresolved)**: (1) I claimed user's phone hit prod without checking logs — user says phone+MacBook hit **test.pc.randomhash.app**; must check daemon log/Caddy before asserting; (2) my own headless-chrome probe is not trusted as evidence — must get independent browser verification from Hermes (another machine) or DEV3 OMP; (3) must answer whether `isLoopback`/`__DSH_TRANSPORT__` is read once (constant at apply) or re-evaluated — source says once at apply (`client/index.ts:228`, literal property; `$host` snapshot at gateway apply), so late loading is irrelevant for the WRITE side, but the question deserves a precise evidence-backed answer.\n\n## Pending Jobs\n- **Diagnose `test.pc.randomhash.app` path**: check `.scratch/dsh-4999.log` + how test.pc.randomhash.app routes (DNS? Caddy? port?) to 4999/4990; likely fix = add `test.pc.randomhash.app` to `trustedPageAuthorities` (and DSH_TRUSTED_HOSTS for the fence), then verify Models on phone/MacBook.\n- **Cross-machine browser verification** via A2A: send test request to Hermes agent (another machine) and/or DEV3 OMP to load the URL and report the Models page + swipe behavior.\n- Answer the mutability question with source evidence (already have: read-once-at-apply; write up precisely).\n- User re-test: Models page, left sidebar swipes (sidecarx-tuned), right panel swipes + better-sidebar, via test.pc.randomhash.app.\n- Change closure: tasks 1.5/2.2/2.4 (device-level confirmations), archive, publish/prod deploy (age-gate exact-version flow) — not yet requested.\n- Cleanup: chrome unit stopped; socat `dsh-4999-lan` + daemon running.\n\n## Current Work\nRound 3 had just been committed (gesture defaults aligned to sidecarx: 50/40/velocity-0; CDP probe proof via 192.168.31.130:4990; tag `v0.2.1f` moved; memory stored) when the user replied with the round-3 corrections: they tested via `test.pc.randomhash.app` from phone AND MacBook (Models broken both), demanded log-checking before instance claims, cross-machine verification via Hermes/OMP, and the variable-mutability answer. No diagnostic action taken yet on these three demands.\n\n## Next Step\nCheck `.scratch/dsh-4999.log` (and Caddy/DNS routing for `test.pc.randomhash.app`) to confirm what the phone/MacBook actually hit; then add `test.pc.randomhash.app` to `trustedPageAuthorities` (+ `DSH_TRUSTED_HOSTS`), restart, and dispatch cross-machine browser verification to Hermes/OMP via A2A — while answering the mutability question (isLoopback computed once at connection apply; `$host` snapshot at gateway apply; boot script wins because it runs before bundle materialization).\n\n## Critical Context\n- 4999 daemon running (token `EWiadkBZ3i2lZ307BBjk1ly4o7v3nrX3Rc1ozyxC0Es`), socat 0.0.0.0:4990→127.0.0.1:4999, better-dash 0.2.1-f round-3 build deployed.\n- `test.pc.randomhash.app` is NOT in any trust list — if it reaches 4999, fence (server) would 403 `/api` and boot script won't flip isLoopback: BOTH legs fail on that hostname; that is consistent with user symptoms on phone AND MacBook.\n- User communication: terse, furious at unverified claims; ALWAYS check logs/evidence first; use remote agents (Hermes/OMP via `mcp__cordis-a2a__a2a_send`) for independent verification; never suggest upstream PRs; never reduce better-dsh to \"a REPL\".\n- The mutability answer (source-verified): `isLoopback` is a plain property computed once in the connection client's `apply()` (`client/index.ts:228`); gateway snapshots `{home, isLoopback}` into hostFacts; ui-settings reads it once at its apply. No per-call re-evaluation. The boot script's head-inline position (before shell main script at HTML offset 23778 < 25168) guarantees it precedes all plugin applies.\n- Local git: commit history through round 3, tag `v0.2.1f` (local only, never pushed)."
    }
   ],
   "rawOutput": [
    {
     "type": "text",
     "text": "## Primary Request and Intent\n- Execute OpenSpec change `2026-09-03-plugin-shipped-ui-patches` (v0.2.1f): ship the two \"user requested\" UI patches WITH the better-dsh plugin instead of local patching — (P2) loopback auth / provider-directory fix, (P3) mobile responsive sidebar + swipe gestures.\n- User verified results and gave three rounds of corrections. Round 3 (current): user tested from phone AND MacBook via **`test.pc.randomhash.app`** (NOT the socat 4990 URL I gave) — Models page still broken there. User demands: (a) CHECK THE SERVER LOGS before claiming which instance/hostname the user hit; (b) use remote agents (Hermes on another machine, or OMP on DEV3) to do real browser tests instead of trusting my own headless-chrome probe; (c) answer the mutability question: is `__DSH_TRANSPORT__`/`isLoopback` read ONCE at apply time (a one-shot constant) or re-evaluated per call — because if the client bundle loads last, the variable may already be patched by the time anyone inspects it.\n- User instruction (standing): swipe/move detection must reference sidecarx implementation (done round 3: sidecarx has NO velocity gate; aligned defaults 50px/40px band/velocity 0).\n- Earlier standing rulings: never suggest upstream PRs (upstream closes all PRs); never summarize better-dsh as \"just a REPL\"; Route A (127.0.0.1 direct access) rejected because the requirement is OTHER-device access.\n\n## Key Technical Concepts\n- **Boot-script mechanism (P2 isLoopback leg)**: host half listens public event `webserver/index-inject` → pushes inline `{kind:'script',placement:'head',text}` into served HTML → runs before any application bundle materializes → sets `window.__DSH_TRANSPORT__={ownsHost:true}` → connection client `apply()` computes `isLoopback` **once at apply time** (source: `packages/client/connection/src/client/index.ts:228` — property on handle literal, evaluated when browser cordis applies the plugin; NOT re-read per call). Delivery vehicle is server-rendered HTML; the variable is a frontend runtime global read by `dsh-client-connection`'s browser half.\n- **P2 fence leg**: bundle patch overrides `connection` row in `dashr/cordis.patch.yml` (whole-row restatement; `!!js` is a **scalar tag — expression must NOT start with `[`**, use `(…).concat(…)` form): `trustedHosts: !!js (process.env.DSH_TRUSTED_HOSTS ?? '').split(/\\s+/).filter(Boolean).concat(ctx.webRuntime.trustedHosts)`.\n- **P2 root cause (settled)**: `ui-settings` reads `ctx.remote.$host.isLoopback` once at apply → non-loopback = `'memory'` persistence = \"terminally unavailable, never touches the wire\" → Models page fails with \"settings are unavailable in this browser\". Upstream design note `2026-08-06-host-backed-web-preferences.md` shows intent was \"preferences remain process-local\" (page works) — mirror over-tightened it; trustedHosts concept never propagated to host facts.\n- **Mobile gestures (round-3 aligned to sidecarx)**: `classifySwipe(sample, thresholds, panels)` panel-aware: left collapsed→rightward from left band opens; left expanded→leftward from ANY origin closes; details closed→leftward from right band opens; details open→rightward (not from left band) closes. Panel state read from AppFrame attrs (`[data-sidebar-collapsed]`/`[data-details-collapsed]` absent = expanded). Defaults: distance 50, edgeBand 40, **velocity 0 (disabled — sidecarx parity)**, breakpoint 1024. touch/pen only, `|dx|>|dy|` required.\n- Client-half config channel: `window.__DASHR_MOBILE__` page global set by same boot script (client bundle gets NO loader config).\n- 4999 test topology: daemon `systemd-run --user --unit=dsh-4999-test` (binds 127.0.0.1 only; `--host 0.0.0.0` deliberately refused by launcher: \"would expose remote code execution\"); socat user unit `dsh-4999-lan` (0.0.0.0:4990→127.0.0.1:4999); env via `EnvironmentFile=.scratch/dsh-4999.env` (`DSH_TRUSTED_HOSTS=probe.example 192.168.31.130`); profile patch at `.dsh-test/profiles/web/cordis.patch.yml` sets `trustedPageAuthorities: ['probe.example','192.168.31.130']`.\n- **NEW unresolved**: user accesses via `test.pc.randomhash.app` — a hostname NOT in trustedPageAuthorities (only `probe.example`, `192.168.31.130`) → boot script does NOT flip ownsHost for it → isLoopback stays false → Models fails. Also `test.pc.randomhash.app` must resolve/proxy to 4999 somehow (unknown — Caddy edit forbidden without approval; DNS/Caddy routing for test.* unverified). MUST check `.scratch/dsh-4999.log` + Caddy config to see what actually happened.\n- CDP probe: `.scratch/cdp-probe.mjs` (ws@8.21.0 from monorepo `.pnpm`; chrome must run via systemd-run user unit `dsh-cdp-chrome` — killed inside sandbox exit 143). Verified via 192.168.31.130:4990: `__DSH_TRANSPORT={ownsHost:true}`, Models renders \"DeepSeek / Edit / Add provider\". User challenges probe reliability — wants cross-machine verification via Hermes/OMP agents (A2A: `mcp__cordis-a2a__a2a_send` to Hermes; DEV3 OMP via a2a too).\n- `dsh-better-sidebar`: 0.17.1 incompatible with alpha.5 (`settingsNamespace` export removed); 0.18.0-alpha.0 installed OK; install = `dsh plugin --profile web add --config.auto-install-peers=false <pkg>`; profile pnpm-workspace needs `allowBuilds: node-pty: true` + `pnpm rebuild node-pty`.\n- RPC replay for diagnosis: `POST /api/<ns>/<method>`, body `{\"type\":\"client-request\",\"rpcId\":\"x\",\"method\":\"<ns>/<method>\",\"payload\":{\"args\":{}}}` — slash namespacing.\n\n## Files and Code\n- `dashr/src/web-trust.ts` (NEW, host half): `buildBootScript(config)` pure fn + `installWebTrust(ctx, config)` — `webserver/index-inject` listener; script sets `__DSH_TRANSPORT__` (no-overwrite guard, JSON-embedded authorities, `{ownsHost:true}` only) + `__DASHR_MOBILE__`; mobile default-ON; malformed authority (port/path/empty) throws `/bare hostname/`.\n- `dashr/src/mobile/gesture.ts` (NEW, pure): `classifySwipe`, `isInteractiveOrigin`, `isNarrowViewport`, `resolveMobileConfig`, `DEFAULT_SWIPE_THRESHOLDS={breakpoint:1024,swipeDistancePx:50,swipeVelocityPxPerMs:0,edgeBandPx:40}`; velocity gate only when `>0`.\n- `dashr/src/mobile/client/index.ts` (NEW, client half): `setupMobileLayout(ctx)` — style tag (`data-plugin`/`data-plugin-css='@pgmi-builds/better-dsh/mobile'`, media query `[data-sidebar-collapsed]{grid-template-columns:0px minmax(0,1fr) 0px !important}`), pointer listeners → `classifySwipe` → `toggleSidebar()/openDetails()/closeDetails()`; `ctx.inject(['layout'],…)` conditional.\n- `dashr/src/index.ts`: Config += `trustedPageAuthorities?: string[]`, `mobile?` (schema via `MOBILE_CONFIG` const; whole schema cast `as unknown as z<Config>` for schemastery intersect inference); apply += `installWebTrust(ctx, config)`.\n- `dashr/src/failover/client/index.ts`: client entry mounts `setupMobileLayout(ctx)`.\n- `dashr/cordis.patch.yml`: += connection row override (fence leg).\n- `dashr/package.json`: version `0.2.1-f`; `dsh.client.inject` += `@deepseek-ai/dsh-client-ui-layout`.\n- `dashr/tsconfig.json`: exclude += `src/mobile/client` (client-half convention).\n- Tests: `dashr/test/web-trust.spec.ts` (8), `dashr/test/mobile-gesture.spec.ts` (10) — 429/429 total.\n- `.scratch/cdp-probe.mjs`, `.scratch/dsh-4999.env`, `.scratch/models-page-proof.png` (screenshot proof).\n- `.dsh-test/profiles/web/cordis.patch.yml`: dashr-repl row override w/ trustedPageAuthorities (currently `['probe.example','192.168.31.130']` — **missing `test.pc.randomhash.app`**).\n- `docs/50_test-reports/v0.2.1f-plugin-shipped-ui-patches实测报告.md`: rounds 1-3 appended.\n- OpenSpec change dir + skill `.agents/skills/dsh-plugin-development/` + AGENTS.md §四 — all updated through round 3.\n- Reference: `~/workspaces/sidecarx/src/webclient/src/app.js:332` (SWIPE_THRESHOLD=50, band 40, no velocity), `components/overlay-viewer.js:226`.\n\n## Errors and Fixes\n- `!!js` leading-`[` → YAML flow-seq rejection: use `(process.env.X ?? '').split(/\\s+/).filter(Boolean).concat(ctx.webRuntime.trustedHosts)`.\n- Duplicate Config schema blocks from edit collisions in `src/index.ts` (twice) + missing `swipeDistancePx` line: fixed by careful re-reads.\n- Headless chrome killed in sandbox (exit 143): run via systemd-run user unit outside sandbox.\n- `--host 0.0.0.0` refused by launcher (intentional upstream safety): socat LAN proxy instead.\n- `systemd-run` with spaced env value → \"Invalid environment block\": use EnvironmentFile.\n- Left-swipe-to-close never fired (round 2): root cause = origin edge-band-only condition rejected swipes starting on the overlay body; fixed with panel-aware classifier (expanded→any origin).\n- Velocity 0.35 \"too fast\" (round 2) → 0.2; round 3 → sidecarx has NO velocity gate → default 0.\n- better-sidebar 0.17.1 crash on alpha.5 (`SyntaxError: ... does not provide an export named 'settingsNamespace'`) → 0.18.0-alpha.0.\n- **User round-3 corrections (unresolved)**: (1) I claimed user's phone hit prod without checking logs — user says phone+MacBook hit **test.pc.randomhash.app**; must check daemon log/Caddy before asserting; (2) my own headless-chrome probe is not trusted as evidence — must get independent browser verification from Hermes (another machine) or DEV3 OMP; (3) must answer whether `isLoopback`/`__DSH_TRANSPORT__` is read once (constant at apply) or re-evaluated — source says once at apply (`client/index.ts:228`, literal property; `$host` snapshot at gateway apply), so late loading is irrelevant for the WRITE side, but the question deserves a precise evidence-backed answer.\n\n## Pending Jobs\n- **Diagnose `test.pc.randomhash.app` path**: check `.scratch/dsh-4999.log` + how test.pc.randomhash.app routes (DNS? Caddy? port?) to 4999/4990; likely fix = add `test.pc.randomhash.app` to `trustedPageAuthorities` (and DSH_TRUSTED_HOSTS for the fence), then verify Models on phone/MacBook.\n- **Cross-machine browser verification** via A2A: send test request to Hermes agent (another machine) and/or DEV3 OMP to load the URL and report the Models page + swipe behavior.\n- Answer the mutability question with source evidence (already have: read-once-at-apply; write up precisely).\n- User re-test: Models page, left sidebar swipes (sidecarx-tuned), right panel swipes + better-sidebar, via test.pc.randomhash.app.\n- Change closure: tasks 1.5/2.2/2.4 (device-level confirmations), archive, publish/prod deploy (age-gate exact-version flow) — not yet requested.\n- Cleanup: chrome unit stopped; socat `dsh-4999-lan` + daemon running.\n\n## Current Work\nRound 3 had just been committed (gesture defaults aligned to sidecarx: 50/40/velocity-0; CDP probe proof via 192.168.31.130:4990; tag `v0.2.1f` moved; memory stored) when the user replied with the round-3 corrections: they tested via `test.pc.randomhash.app` from phone AND MacBook (Models broken both), demanded log-checking before instance claims, cross-machine verification via Hermes/OMP, and the variable-mutability answer. No diagnostic action taken yet on these three demands.\n\n## Next Step\nCheck `.scratch/dsh-4999.log` (and Caddy/DNS routing for `test.pc.randomhash.app`) to confirm what the phone/MacBook actually hit; then add `test.pc.randomhash.app` to `trustedPageAuthorities` (+ `DSH_TRUSTED_HOSTS`), restart, and dispatch cross-machine browser verification to Hermes/OMP via A2A — while answering the mutability question (isLoopback computed once at connection apply; `$host` snapshot at gateway apply; boot script wins because it runs before bundle materialization).\n\n## Critical Context\n- 4999 daemon running (token `EWiadkBZ3i2lZ307BBjk1ly4o7v3nrX3Rc1ozyxC0Es`), socat 0.0.0.0:4990→127.0.0.1:4999, better-dash 0.2.1-f round-3 build deployed.\n- `test.pc.randomhash.app` is NOT in any trust list — if it reaches 4999, fence (server) would 403 `/api` and boot script won't flip isLoopback: BOTH legs fail on that hostname; that is consistent with user symptoms on phone AND MacBook.\n- User communication: terse, furious at unverified claims; ALWAYS check logs/evidence first; use remote agents (Hermes/OMP via `mcp__cordis-a2a__a2a_send`) for independent verification; never suggest upstream PRs; never reduce better-dsh to \"a REPL\".\n- The mutability answer (source-verified): `isLoopback` is a plain property computed once in the connection client's `apply()` (`client/index.ts:228`); gateway snapshots `{home, isLoopback}` into hostFacts; ui-settings reads it once at its apply. No per-call re-evaluation. The boot script's head-inline position (before shell main script at HTML offset 23778 < 25168) guarantees it precedes all plugin applies.\n- Local git: commit history through round 3, tag `v0.2.1f` (local only, never pushed)."
    }
   ],
   "llmStreamCall": true,
   "shadowedRange": {
    "start": 109246,
    "end": 220120
   },
   "shadowedSeqs": [
    109246,
    109240,
    109257,
    109258,
    109259,
    109260,
    111302,
    111305,
    111307,
    111309,
    111311,
    111313,
    111369,
    111371,
    111373,
    111375,
    111377,
    114658,
    114660,
    114662,
    114664,
    116476,
    116478,
    116480,
    116482,
    116484,
    117388,
    117390,
    117392,
    117394,
    118349,
    118351,
    118353,
    118355,
    119730,
    119732,
    119734,
    119736,
    121330,
    121332,
    121413,
    121415,
    121417,
    123902,
    123904,
    123906,
    123908,
    124365,
    124367,
    124369,
    124371,
    124373,
    124958,
    124960,
    124962,
    124964,
    126732,
    126734,
    126736,
    126738,
    129592,
    129594,
    129596,
    129598,
    130087,
    130089,
    130091,
    131558,
    131560,
    131562,
    133302,
    133304,
    133306,
    135169,
    135171,
    135173,
    135869,
    135871,
    136168,
    136170,
    137845,
    137848,
    137850,
    139065,
    139067,
    139097,
    139099,
    139138,
    139140,
    139142,
    139144,
    139175,
    139177,
    139179,
    139233,
    139235,
    139397,
    139399,
    139407,
    139409,
    139436,
    139438,
    139446,
    139448,
    139645,
    139647,
    139740,
    139742,
    139750,
    139752,
    139755,
    140066,
    140068,
    140079,
    140082,
    140084,
    140092,
    140094,
    141072,
    141079,
    141080,
    143157,
    143164,
    143165,
    148739,
    148741,
    148743,
    152220,
    152222,
    152224,
    152235,
    152237,
    152239,
    153361,
    153368,
    153369,
    159680,
    159682,
    160244,
    160246,
    162892,
    162894,
    163802,
    163804,
    163812,
    163814,
    163822,
    163824,
    164288,
    164290,
    164301,
    164303,
    164305,
    164344,
    164346,
    164348,
    164697,
    164699,
    164710,
    164712,
    164714,
    165816,
    165823,
    165824,
    168403,
    168405,
    168413,
    168415,
    168507,
    168509,
    168614,
    168616,
    170643,
    170645,
    170773,
    170775,
    170777,
    170788,
    170790,
    170792,
    170800,
    170802,
    171627,
    171634,
    171635,
    172329,
    172331,
    172333,
    172454,
    172456,
    172458,
    174911,
    174913,
    174915,
    178776,
    178778,
    178901,
    178903,
    179146,
    179148,
    179447,
    179449,
    180027,
    180029,
    180040,
    180042,
    180044,
    180126,
    180128,
    180525,
    180527,
    180535,
    180537,
    180545,
    180547,
    180595,
    180597,
    180605,
    180607,
    181376,
    181378,
    181515,
    181517,
    181528,
    181530,
    181532,
    182392,
    182394,
    182463,
    182465,
    182467,
    182475,
    182477,
    182485,
    182487,
    182644,
    182646,
    182654,
    182656,
    183001,
    183003,
    183011,
    183013,
    183021,
    183023,
    183175,
    183177,
    183334,
    183336,
    183344,
    183346,
    183354,
    183356,
    183412,
    183414,
    183422,
    183424,
    183432,
    183434,
    183504,
    183506,
    183514,
    183516,
    183524,
    183526,
    183889,
    183891,
    184145,
    184147,
    184149,
    184221,
    184223,
    184231,
    184233,
    184585,
    184587,
    185300,
    185302,
    185505,
    185507,
    185515,
    185517,
    185761,
    185763,
    185771,
    185773,
    185781,
    185783,
    185791,
    185793,
    185801,
    185803,
    185811,
    185813,
    185821,
    185823,
    185969,
    185971,
    185979,
    185981,
    186717,
    186719,
    186721,
    186729,
    186731,
    187222,
    187224,
    187381,
    187383,
    187391,
    187393,
    187491,
    187495,
    187503,
    187505,
    187866,
    187868,
    188010,
    188012,
    188223,
    188225,
    188493,
    188495,
    188503,
    188505,
    188513,
    188515,
    189446,
    189448,
    189456,
    189458,
    189466,
    189468,
    189476,
    189478,
    189486,
    189488,
    189851,
    189853,
    189855,
    189982,
    189984,
    189992,
    189994,
    190002,
    190004,
    190007,
    190299,
    190301,
    190309,
    190311,
    190314,
    190753,
    190755,
    190763,
    190765,
    191290,
    191292,
    191972,
    191979,
    191980,
    196445,
    196447,
    197094,
    197096,
    197594,
    197596,
    197604,
    197606,
    197681,
    197683,
    197691,
    197693,
    197701,
    197703,
    197711,
    197713,
    197896,
    197898,
    197906,
    197908,
    197916,
    197918,
    197926,
    197928,
    197936,
    197938,
    198420,
    198422,
    198607,
    198609,
    198684,
    198686,
    198694,
    198696,
    198704,
    198706,
    198798,
    198800,
    198808,
    198810,
    198818,
    198820,
    198872,
    198874,
    201895,
    201897,
    201982,
    201984,
    201992,
    201994,
    202081,
    202083,
    202091,
    202093,
    202101,
    202103,
    203089,
    203091,
    203118,
    203120,
    203122,
    203142,
    203144,
    203152,
    203154,
    203162,
    203164,
    203172,
    203174,
    203467,
    203469,
    203477,
    203479,
    203487,
    203489,
    203773,
    203775,
    203783,
    203785,
    203793,
    203795,
    203803,
    203805,
    203813,
    203815,
    203918,
    203920,
    203928,
    203930,
    203938,
    203940,
    204179,
    204181,
    204189,
    204193,
    204201,
    204205,
    204213,
    204217,
    204394,
    204396,
    204404,
    204408,
    204581,
    204583,
    204814,
    204818,
    204826,
    204828,
    204995,
    204999,
    205007,
    205011,
    205019,
    205021,
    205092,
    205094,
    205909,
    205913,
    205921,
    205925,
    206252,
    206256,
    206264,
    206268,
    206414,
    206416,
    206424,
    206426,
    206496,
    206498,
    206506,
    206508,
    206997,
    206999,
    207007,
    207009,
    207017,
    207021,
    207029,
    207033,
    207260,
    207262,
    208233,
    208235,
    208243,
    208245,
    209034,
    209041,
    209042,
    213322,
    213324,
    213725,
    213727,
    213735,
    213737,
    214869,
    214871,
    214879,
    214881,
    215357,
    215359,
    215361,
    215517,
    215521,
    215529,
    215531,
    216279,
    216281,
    216289,
    216291,
    216299,
    216301,
    216309,
    216311,
    216770,
    216772,
    216780,
    216782,
    218271,
    218273,
    218722,
    218724,
    218732,
    218734,
    218742,
    218746,
    218754,
    218756,
    218764,
    218766,
    219280,
    219282,
    219290,
    219292,
    220112,
    220119,
    220120
   ],
   "shadowedTokenCount": 347901,
   "provider": "zai-plan",
   "model": "glm-5.3",
   "maxTokens": 8192,
   "usage": {
    "inputTokens": 379,
    "outputTokens": 3401,
    "totalTokens": 417348,
    "cacheReadTokens": 413568
   }
  }
 },
 {
  "type": "user/message",
  "seq": 221218,
  "time": 1788391831673,
  "data": {
   "content": [
    {
     "type": "text",
     "text": "This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.\n\n<compacted-summary>"
    },
    {
     "type": "text",
     "text": "## Primary Request and Intent\n- Execute OpenSpec change `2026-09-03-plugin-shipped-ui-patches` (v0.2.1f): ship the two \"user requested\" UI patches WITH the better-dsh plugin instead of local patching — (P2) loopback auth / provider-directory fix, (P3) mobile responsive sidebar + swipe gestures.\n- User verified results and gave three rounds of corrections. Round 3 (current): user tested from phone AND MacBook via **`test.pc.randomhash.app`** (NOT the socat 4990 URL I gave) — Models page still broken there. User demands: (a) CHECK THE SERVER LOGS before claiming which instance/hostname the user hit; (b) use remote agents (Hermes on another machine, or OMP on DEV3) to do real browser tests instead of trusting my own headless-chrome probe; (c) answer the mutability question: is `__DSH_TRANSPORT__`/`isLoopback` read ONCE at apply time (a one-shot constant) or re-evaluated per call — because if the client bundle loads last, the variable may already be patched by the time anyone inspects it.\n- User instruction (standing): swipe/move detection must reference sidecarx implementation (done round 3: sidecarx has NO velocity gate; aligned defaults 50px/40px band/velocity 0).\n- Earlier standing rulings: never suggest upstream PRs (upstream closes all PRs); never summarize better-dsh as \"just a REPL\"; Route A (127.0.0.1 direct access) rejected because the requirement is OTHER-device access.\n\n## Key Technical Concepts\n- **Boot-script mechanism (P2 isLoopback leg)**: host half listens public event `webserver/index-inject` → pushes inline `{kind:'script',placement:'head',text}` into served HTML → runs before any application bundle materializes → sets `window.__DSH_TRANSPORT__={ownsHost:true}` → connection client `apply()` computes `isLoopback` **once at apply time** (source: `packages/client/connection/src/client/index.ts:228` — property on handle literal, evaluated when browser cordis applies the plugin; NOT re-read per call). Delivery vehicle is server-rendered HTML; the variable is a frontend runtime global read by `dsh-client-connection`'s browser half.\n- **P2 fence leg**: bundle patch overrides `connection` row in `dashr/cordis.patch.yml` (whole-row restatement; `!!js` is a **scalar tag — expression must NOT start with `[`**, use `(…).concat(…)` form): `trustedHosts: !!js (process.env.DSH_TRUSTED_HOSTS ?? '').split(/\\s+/).filter(Boolean).concat(ctx.webRuntime.trustedHosts)`.\n- **P2 root cause (settled)**: `ui-settings` reads `ctx.remote.$host.isLoopback` once at apply → non-loopback = `'memory'` persistence = \"terminally unavailable, never touches the wire\" → Models page fails with \"settings are unavailable in this browser\". Upstream design note `2026-08-06-host-backed-web-preferences.md` shows intent was \"preferences remain process-local\" (page works) — mirror over-tightened it; trustedHosts concept never propagated to host facts.\n- **Mobile gestures (round-3 aligned to sidecarx)**: `classifySwipe(sample, thresholds, panels)` panel-aware: left collapsed→rightward from left band opens; left expanded→leftward from ANY origin closes; details closed→leftward from right band opens; details open→rightward (not from left band) closes. Panel state read from AppFrame attrs (`[data-sidebar-collapsed]`/`[data-details-collapsed]` absent = expanded). Defaults: distance 50, edgeBand 40, **velocity 0 (disabled — sidecarx parity)**, breakpoint 1024. touch/pen only, `|dx|>|dy|` required.\n- Client-half config channel: `window.__DASHR_MOBILE__` page global set by same boot script (client bundle gets NO loader config).\n- 4999 test topology: daemon `systemd-run --user --unit=dsh-4999-test` (binds 127.0.0.1 only; `--host 0.0.0.0` deliberately refused by launcher: \"would expose remote code execution\"); socat user unit `dsh-4999-lan` (0.0.0.0:4990→127.0.0.1:4999); env via `EnvironmentFile=.scratch/dsh-4999.env` (`DSH_TRUSTED_HOSTS=probe.example 192.168.31.130`); profile patch at `.dsh-test/profiles/web/cordis.patch.yml` sets `trustedPageAuthorities: ['probe.example','192.168.31.130']`.\n- **NEW unresolved**: user accesses via `test.pc.randomhash.app` — a hostname NOT in trustedPageAuthorities (only `probe.example`, `192.168.31.130`) → boot script does NOT flip ownsHost for it → isLoopback stays false → Models fails. Also `test.pc.randomhash.app` must resolve/proxy to 4999 somehow (unknown — Caddy edit forbidden without approval; DNS/Caddy routing for test.* unverified). MUST check `.scratch/dsh-4999.log` + Caddy config to see what actually happened.\n- CDP probe: `.scratch/cdp-probe.mjs` (ws@8.21.0 from monorepo `.pnpm`; chrome must run via systemd-run user unit `dsh-cdp-chrome` — killed inside sandbox exit 143). Verified via 192.168.31.130:4990: `__DSH_TRANSPORT={ownsHost:true}`, Models renders \"DeepSeek / Edit / Add provider\". User challenges probe reliability — wants cross-machine verification via Hermes/OMP agents (A2A: `mcp__cordis-a2a__a2a_send` to Hermes; DEV3 OMP via a2a too).\n- `dsh-better-sidebar`: 0.17.1 incompatible with alpha.5 (`settingsNamespace` export removed); 0.18.0-alpha.0 installed OK; install = `dsh plugin --profile web add --config.auto-install-peers=false <pkg>`; profile pnpm-workspace needs `allowBuilds: node-pty: true` + `pnpm rebuild node-pty`.\n- RPC replay for diagnosis: `POST /api/<ns>/<method>`, body `{\"type\":\"client-request\",\"rpcId\":\"x\",\"method\":\"<ns>/<method>\",\"payload\":{\"args\":{}}}` — slash namespacing.\n\n## Files and Code\n- `dashr/src/web-trust.ts` (NEW, host half): `buildBootScript(config)` pure fn + `installWebTrust(ctx, config)` — `webserver/index-inject` listener; script sets `__DSH_TRANSPORT__` (no-overwrite guard, JSON-embedded authorities, `{ownsHost:true}` only) + `__DASHR_MOBILE__`; mobile default-ON; malformed authority (port/path/empty) throws `/bare hostname/`.\n- `dashr/src/mobile/gesture.ts` (NEW, pure): `classifySwipe`, `isInteractiveOrigin`, `isNarrowViewport`, `resolveMobileConfig`, `DEFAULT_SWIPE_THRESHOLDS={breakpoint:1024,swipeDistancePx:50,swipeVelocityPxPerMs:0,edgeBandPx:40}`; velocity gate only when `>0`.\n- `dashr/src/mobile/client/index.ts` (NEW, client half): `setupMobileLayout(ctx)` — style tag (`data-plugin`/`data-plugin-css='@pgmi-builds/better-dsh/mobile'`, media query `[data-sidebar-collapsed]{grid-template-columns:0px minmax(0,1fr) 0px !important}`), pointer listeners → `classifySwipe` → `toggleSidebar()/openDetails()/closeDetails()`; `ctx.inject(['layout'],…)` conditional.\n- `dashr/src/index.ts`: Config += `trustedPageAuthorities?: string[]`, `mobile?` (schema via `MOBILE_CONFIG` const; whole schema cast `as unknown as z<Config>` for schemastery intersect inference); apply += `installWebTrust(ctx, config)`.\n- `dashr/src/failover/client/index.ts`: client entry mounts `setupMobileLayout(ctx)`.\n- `dashr/cordis.patch.yml`: += connection row override (fence leg).\n- `dashr/package.json`: version `0.2.1-f`; `dsh.client.inject` += `@deepseek-ai/dsh-client-ui-layout`.\n- `dashr/tsconfig.json`: exclude += `src/mobile/client` (client-half convention).\n- Tests: `dashr/test/web-trust.spec.ts` (8), `dashr/test/mobile-gesture.spec.ts` (10) — 429/429 total.\n- `.scratch/cdp-probe.mjs`, `.scratch/dsh-4999.env`, `.scratch/models-page-proof.png` (screenshot proof).\n- `.dsh-test/profiles/web/cordis.patch.yml`: dashr-repl row override w/ trustedPageAuthorities (currently `['probe.example','192.168.31.130']` — **missing `test.pc.randomhash.app`**).\n- `docs/50_test-reports/v0.2.1f-plugin-shipped-ui-patches实测报告.md`: rounds 1-3 appended.\n- OpenSpec change dir + skill `.agents/skills/dsh-plugin-development/` + AGENTS.md §四 — all updated through round 3.\n- Reference: `~/workspaces/sidecarx/src/webclient/src/app.js:332` (SWIPE_THRESHOLD=50, band 40, no velocity), `components/overlay-viewer.js:226`.\n\n## Errors and Fixes\n- `!!js` leading-`[` → YAML flow-seq rejection: use `(process.env.X ?? '').split(/\\s+/).filter(Boolean).concat(ctx.webRuntime.trustedHosts)`.\n- Duplicate Config schema blocks from edit collisions in `src/index.ts` (twice) + missing `swipeDistancePx` line: fixed by careful re-reads.\n- Headless chrome killed in sandbox (exit 143): run via systemd-run user unit outside sandbox.\n- `--host 0.0.0.0` refused by launcher (intentional upstream safety): socat LAN proxy instead.\n- `systemd-run` with spaced env value → \"Invalid environment block\": use EnvironmentFile.\n- Left-swipe-to-close never fired (round 2): root cause = origin edge-band-only condition rejected swipes starting on the overlay body; fixed with panel-aware classifier (expanded→any origin).\n- Velocity 0.35 \"too fast\" (round 2) → 0.2; round 3 → sidecarx has NO velocity gate → default 0.\n- better-sidebar 0.17.1 crash on alpha.5 (`SyntaxError: ... does not provide an export named 'settingsNamespace'`) → 0.18.0-alpha.0.\n- **User round-3 corrections (unresolved)**: (1) I claimed user's phone hit prod without checking logs — user says phone+MacBook hit **test.pc.randomhash.app**; must check daemon log/Caddy before asserting; (2) my own headless-chrome probe is not trusted as evidence — must get independent browser verification from Hermes (another machine) or DEV3 OMP; (3) must answer whether `isLoopback`/`__DSH_TRANSPORT__` is read once (constant at apply) or re-evaluated — source says once at apply (`client/index.ts:228`, literal property; `$host` snapshot at gateway apply), so late loading is irrelevant for the WRITE side, but the question deserves a precise evidence-backed answer.\n\n## Pending Jobs\n- **Diagnose `test.pc.randomhash.app` path**: check `.scratch/dsh-4999.log` + how test.pc.randomhash.app routes (DNS? Caddy? port?) to 4999/4990; likely fix = add `test.pc.randomhash.app` to `trustedPageAuthorities` (and DSH_TRUSTED_HOSTS for the fence), then verify Models on phone/MacBook.\n- **Cross-machine browser verification** via A2A: send test request to Hermes agent (another machine) and/or DEV3 OMP to load the URL and report the Models page + swipe behavior.\n- Answer the mutability question with source evidence (already have: read-once-at-apply; write up precisely).\n- User re-test: Models page, left sidebar swipes (sidecarx-tuned), right panel swipes + better-sidebar, via test.pc.randomhash.app.\n- Change closure: tasks 1.5/2.2/2.4 (device-level confirmations), archive, publish/prod deploy (age-gate exact-version flow) — not yet requested.\n- Cleanup: chrome unit stopped; socat `dsh-4999-lan` + daemon running.\n\n## Current Work\nRound 3 had just been committed (gesture defaults aligned to sidecarx: 50/40/velocity-0; CDP probe proof via 192.168.31.130:4990; tag `v0.2.1f` moved; memory stored) when the user replied with the round-3 corrections: they tested via `test.pc.randomhash.app` from phone AND MacBook (Models broken both), demanded log-checking before instance claims, cross-machine verification via Hermes/OMP, and the variable-mutability answer. No diagnostic action taken yet on these three demands.\n\n## Next Step\nCheck `.scratch/dsh-4999.log` (and Caddy/DNS routing for `test.pc.randomhash.app`) to confirm what the phone/MacBook actually hit; then add `test.pc.randomhash.app` to `trustedPageAuthorities` (+ `DSH_TRUSTED_HOSTS`), restart, and dispatch cross-machine browser verification to Hermes/OMP via A2A — while answering the mutability question (isLoopback computed once at connection apply; `$host` snapshot at gateway apply; boot script wins because it runs before bundle materialization).\n\n## Critical Context\n- 4999 daemon running (token `EWiadkBZ3i2lZ307BBjk1ly4o7v3nrX3Rc1ozyxC0Es`), socat 0.0.0.0:4990→127.0.0.1:4999, better-dash 0.2.1-f round-3 build deployed.\n- `test.pc.randomhash.app` is NOT in any trust list — if it reaches 4999, fence (server) would 403 `/api` and boot script won't flip isLoopback: BOTH legs fail on that hostname; that is consistent with user symptoms on phone AND MacBook.\n- User communication: terse, furious at unverified claims; ALWAYS check logs/evidence first; use remote agents (Hermes/OMP via `mcp__cordis-a2a__a2a_send`) for independent verification; never suggest upstream PRs; never reduce better-dsh to \"a REPL\".\n- The mutability answer (source-verified): `isLoopback` is a plain property computed once in the connection client's `apply()` (`client/index.ts:228`); gateway snapshots `{home, isLoopback}` into hostFacts; ui-settings reads it once at its apply. No per-call re-evaluation. The boot script's head-inline position (before shell main script at HTML offset 23778 < 25168) guarantees it precedes all plugin applies.\n- Local git: commit history through round 3, tag `v0.2.1f` (local only, never pushed)."
    },
    {
     "type": "text",
     "text": "</compacted-summary>"
    }
   ],
   "source": {
    "kind": "plugin",
    "plugin": "compact",
    "compactionId": "0e2d4a6c-a47a-464e-b3f8-dc2e2bb12a23",
    "sourceCommandId": "cmd-32ef6997-3"
   },
   "role": "user",
   "id": "880ceb99-fd29-46b3-bd00-d7ee191c9704"
  },
  "sourceEventSeqs": [
   221216,
   221217,
   109246,
   109240,
   109257,
   109258,
   109259,
   109260,
   111302,
   111305,
   111307,
   111309,
   111311,
   111313,
   111369,
   111371,
   111373,
   111375,
   111377,
   114658,
   114660,
   114662,
   114664,
   116476,
   116478,
   116480,
   116482,
   116484,
   117388,
   117390,
   117392,
   117394,
   118349,
   118351,
   118353,
   118355,
   119730,
   119732,
   119734,
   119736,
   121330,
   121332,
   121413,
   121415,
   121417,
   123902,
   123904,
   123906,
   123908,
   124365,
   124367,
   124369,
   124371,
   124373,
   124958,
   124960,
   124962,
   124964,
   126732,
   126734,
   126736,
   126738,
   129592,
   129594,
   129596,
   129598,
   130087,
   130089,
   130091,
   131558,
   131560,
   131562,
   133302,
   133304,
   133306,
   135169,
   135171,
   135173,
   135869,
   135871,
   136168,
   136170,
   137845,
   137848,
   137850,
   139065,
   139067,
   139097,
   139099,
   139138,
   139140,
   139142,
   139144,
   139175,
   139177,
   139179,
   139233,
   139235,
   139397,
   139399,
   139407,
   139409,
   139436,
   139438,
   139446,
   139448,
   139645,
   139647,
   139740,
   139742,
   139750,
   139752,
   139755,
   140066,
   140068,
   140079,
   140082,
   140084,
   140092,
   140094,
   141072,
   141079,
   141080,
   143157,
   143164,
   143165,
   148739,
   148741,
   148743,
   152220,
   152222,
   152224,
   152235,
   152237,
   152239,
   153361,
   153368,
   153369,
   159680,
   159682,
   160244,
   160246,
   162892,
   162894,
   163802,
   163804,
   163812,
   163814,
   163822,
   163824,
   164288,
   164290,
   164301,
   164303,
   164305,
   164344,
   164346,
   164348,
   164697,
   164699,
   164710,
   164712,
   164714,
   165816,
   165823,
   165824,
   168403,
   168405,
   168413,
   168415,
   168507,
   168509,
   168614,
   168616,
   170643,
   170645,
   170773,
   170775,
   170777,
   170788,
   170790,
   170792,
   170800,
   170802,
   171627,
   171634,
   171635,
   172329,
   172331,
   172333,
   172454,
   172456,
   172458,
   174911,
   174913,
   174915,
   178776,
   178778,
   178901,
   178903,
   179146,
   179148,
   179447,
   179449,
   180027,
   180029,
   180040,
   180042,
   180044,
   180126,
   180128,
   180525,
   180527,
   180535,
   180537,
   180545,
   180547,
   180595,
   180597,
   180605,
   180607,
   181376,
   181378,
   181515,
   181517,
   181528,
   181530,
   181532,
   182392,
   182394,
   182463,
   182465,
   182467,
   182475,
   182477,
   182485,
   182487,
   182644,
   182646,
   182654,
   182656,
   183001,
   183003,
   183011,
   183013,
   183021,
   183023,
   183175,
   183177,
   183334,
   183336,
   183344,
   183346,
   183354,
   183356,
   183412,
   183414,
   183422,
   183424,
   183432,
   183434,
   183504,
   183506,
   183514,
   183516,
   183524,
   183526,
   183889,
   183891,
   184145,
   184147,
   184149,
   184221,
   184223,
   184231,
   184233,
   184585,
   184587,
   185300,
   185302,
   185505,
   185507,
   185515,
   185517,
   185761,
   185763,
   185771,
   185773,
   185781,
   185783,
   185791,
   185793,
   185801,
   185803,
   185811,
   185813,
   185821,
   185823,
   185969,
   185971,
   185979,
   185981,
   186717,
   186719,
   186721,
   186729,
   186731,
   187222,
   187224,
   187381,
   187383,
   187391,
   187393,
   187491,
   187495,
   187503,
   187505,
   187866,
   187868,
   188010,
   188012,
   188223,
   188225,
   188493,
   188495,
   188503,
   188505,
   188513,
   188515,
   189446,
   189448,
   189456,
   189458,
   189466,
   189468,
   189476,
   189478,
   189486,
   189488,
   189851,
   189853,
   189855,
   189982,
   189984,
   189992,
   189994,
   190002,
   190004,
   190007,
   190299,
   190301,
   190309,
   190311,
   190314,
   190753,
   190755,
   190763,
   190765,
   191290,
   191292,
   191972,
   191979,
   191980,
   196445,
   196447,
   197094,
   197096,
   197594,
   197596,
   197604,
   197606,
   197681,
   197683,
   197691,
   197693,
   197701,
   197703,
   197711,
   197713,
   197896,
   197898,
   197906,
   197908,
   197916,
   197918,
   197926,
   197928,
   197936,
   197938,
   198420,
   198422,
   198607,
   198609,
   198684,
   198686,
   198694,
   198696,
   198704,
   198706,
   198798,
   198800,
   198808,
   198810,
   198818,
   198820,
   198872,
   198874,
   201895,
   201897,
   201982,
   201984,
   201992,
   201994,
   202081,
   202083,
   202091,
   202093,
   202101,
   202103,
   203089,
   203091,
   203118,
   203120,
   203122,
   203142,
   203144,
   203152,
   203154,
   203162,
   203164,
   203172,
   203174,
   203467,
   203469,
   203477,
   203479,
   203487,
   203489,
   203773,
   203775,
   203783,
   203785,
   203793,
   203795,
   203803,
   203805,
   203813,
   203815,
   203918,
   203920,
   203928,
   203930,
   203938,
   203940,
   204179,
   204181,
   204189,
   204193,
   204201,
   204205,
   204213,
   204217,
   204394,
   204396,
   204404,
   204408,
   204581,
   204583,
   204814,
   204818,
   204826,
   204828,
   204995,
   204999,
   205007,
   205011,
   205019,
   205021,
   205092,
   205094,
   205909,
   205913,
   205921,
   205925,
   206252,
   206256,
   206264,
   206268,
   206414,
   206416,
   206424,
   206426,
   206496,
   206498,
   206506,
   206508,
   206997,
   206999,
   207007,
   207009,
   207017,
   207021,
   207029,
   207033,
   207260,
   207262,
   208233,
   208235,
   208243,
   208245,
   209034,
   209041,
   209042,
   213322,
   213324,
   213725,
   213727,
   213735,
   213737,
   214869,
   214871,
   214879,
   214881,
   215357,
   215359,
   215361,
   215517,
   215521,
   215529,
   215531,
   216279,
   216281,
   216289,
   216291,
   216299,
   216301,
   216309,
   216311,
   216770,
   216772,
   216780,
   216782,
   218271,
   218273,
   218722,
   218724,
   218732,
   218734,
   218742,
   218746,
   218754,
   218756,
   218764,
   218766,
   219280,
   219282,
   219290,
   219292,
   220112,
   220119,
   220120
  ],
  "surfaceOp": {
   "op": "replace",
   "start": 109246,
   "end": 220120
  }
 },
 {
  "type": "compaction/end",
  "seq": 221219,
  "time": 1788391831678,
  "data": {
   "compactionId": "0e2d4a6c-a47a-464e-b3f8-dc2e2bb12a23",
   "sourceCommandId": "cmd-32ef6997-3",
   "turn": null
  }
 },
 {
  "type": "command/done",
  "seq": 221220,
  "time": 1788391831684,
  "data": {
   "commandId": "cmd-32ef6997-3",
   "kind": "success",
   "text": "Compacted 559 history items (~347901 tokens).",
   "sourceEventSeq": 221217
  }
 }
]
```

## 10. 被压缩的 559 个 item 实际构成（EPISODE-2 shadowedSeqs 逐项普查）

### 10.1 类型构成

| 类型 | 数量 | 构成明细 |
|---|---|---|
| `tool/result` | 292 | 与 assistant 消息里的 tool-call 块严格配对（292=292） |
| `assistant/message` | 243 | 块构成：**292 tool-call** + 133 reasoning + 63 text |
| `user/message` | 24 | **9 真实用户输入** + 9 corti-memory 注入 + 4 agent-instructions + 1 上次 checkpoint + 1 system-prompt snapshot |

即：559 items ≈ 一段 24 轮助手工作流（turn 15..23 的压缩跨度），其中 292 次工具调用、243 条助手消息（多数是「纯 tool-call + reasoning、无正文」的消息）、24 条用户侧消息里只有 9 条是人类真实输入——**其余 15 条是宿主/插件注入的伪 user 消息**（memory 回忆、指令基线、运行时快照）。

### 10.2 工具调用分布（tool/result.sourceEventSeqs[0] → tool/call 配对解析）

| 工具 | 次数 | 工具 | 次数 |
|---|---|---|---|
| bash | 159 | glob | 6 |
| read | 48 | memory_add | 6 |
| edit | 37 | todo_write | 3 |
| write | 18 | memory_flush | 2 |
| grep | 11 | memory_search / read_image | 各 1 |

### 10.3 体量分布（event.data 的 JSON 字符数）

| 类型 | n | min | 中位 | p90 | max | 合计 |
|---|---|---|---|---|---|---|
| user/message | 24 | 223 | 1,393 | 13,135 | 13,828 | 88 KB |
| assistant/message | 243 | 638 | 1,734 | 8,355 | 29,341 | 810 KB |
| tool/result | 292 | 315 | 888 | 6,520 | **67,835** | 766 KB |

合计 ~1.66 MB 原始 JSON ≈ 官方计的 347,901 tokens。**重要事实：JSONL 里的 tool/result 是全量原文，没有任何截断**——最大单条是 read 的 67.8KB 返回；截断（spill 文件、tail 截取）只发生在工具返回给模型的渲染层。对 ctx 子资源设计的含义：按 label 解引用拿到的是完整原始结果，截断策略完全由资源层自己决定。

### 10.4 top-10 最大 item

```
   67835  seq=172456  tool/result   read      (turn 20)
   49795  seq=114662  tool/result   grep      (turn 15)
   29341  seq=159680  assistant/message        (reasoning+text)
   24945  seq=148739  assistant/message
   23342  seq=178776  assistant/message
   19995  seq=174913  tool/result   read
   19965  seq=196445  assistant/message
   19243  seq=213322  assistant/message
   17799  seq=121417  tool/result   read
   17572  seq=148741  tool/result   read
```

### 10.5 配对机制（tool_calls 子资源的实现入口）

- `tool/result.data.message.content[].tool-result.toolCallId` = 配对键；`tool/result.sourceEventSeqs[0]` 直接指向配对的 `tool/call` 事件（`{turn, step, callId, name, arguments}`，arguments 是 JSON 字符串）。
- assistant 消息内另有同 callId 的 `tool-call` 块（调用名+参数的内联副本）。
- 因此 **tool_calls 子资源有两条冗余重建路径**（tool/call 事件 或 assistant 块），纯 JSON 游走即可，不需 host API。

## 11. EPISODE-2 八段摘要全文（12,539 chars，逐字）

```markdown
## Primary Request and Intent
- Execute OpenSpec change `2026-09-03-plugin-shipped-ui-patches` (v0.2.1f): ship the two "user requested" UI patches WITH the better-dsh plugin instead of local patching — (P2) loopback auth / provider-directory fix, (P3) mobile responsive sidebar + swipe gestures.
- User verified results and gave three rounds of corrections. Round 3 (current): user tested from phone AND MacBook via **`test.pc.randomhash.app`** (NOT the socat 4990 URL I gave) — Models page still broken there. User demands: (a) CHECK THE SERVER LOGS before claiming which instance/hostname the user hit; (b) use remote agents (Hermes on another machine, or OMP on DEV3) to do real browser tests instead of trusting my own headless-chrome probe; (c) answer the mutability question: is `__DSH_TRANSPORT__`/`isLoopback` read ONCE at apply time (a one-shot constant) or re-evaluated per call — because if the client bundle loads last, the variable may already be patched by the time anyone inspects it.
- User instruction (standing): swipe/move detection must reference sidecarx implementation (done round 3: sidecarx has NO velocity gate; aligned defaults 50px/40px band/velocity 0).
- Earlier standing rulings: never suggest upstream PRs (upstream closes all PRs); never summarize better-dsh as "just a REPL"; Route A (127.0.0.1 direct access) rejected because the requirement is OTHER-device access.

## Key Technical Concepts
- **Boot-script mechanism (P2 isLoopback leg)**: host half listens public event `webserver/index-inject` → pushes inline `{kind:'script',placement:'head',text}` into served HTML → runs before any application bundle materializes → sets `window.__DSH_TRANSPORT__={ownsHost:true}` → connection client `apply()` computes `isLoopback` **once at apply time** (source: `packages/client/connection/src/client/index.ts:228` — property on handle literal, evaluated when browser cordis applies the plugin; NOT re-read per call). Delivery vehicle is server-rendered HTML; the variable is a frontend runtime global read by `dsh-client-connection`'s browser half.
- **P2 fence leg**: bundle patch overrides `connection` row in `dashr/cordis.patch.yml` (whole-row restatement; `!!js` is a **scalar tag — expression must NOT start with `[`**, use `(…).concat(…)` form): `trustedHosts: !!js (process.env.DSH_TRUSTED_HOSTS ?? '').split(/\s+/).filter(Boolean).concat(ctx.webRuntime.trustedHosts)`.
- **P2 root cause (settled)**: `ui-settings` reads `ctx.remote.$host.isLoopback` once at apply → non-loopback = `'memory'` persistence = "terminally unavailable, never touches the wire" → Models page fails with "settings are unavailable in this browser". Upstream design note `2026-08-06-host-backed-web-preferences.md` shows intent was "preferences remain process-local" (page works) — mirror over-tightened it; trustedHosts concept never propagated to host facts.
- **Mobile gestures (round-3 aligned to sidecarx)**: `classifySwipe(sample, thresholds, panels)` panel-aware: left collapsed→rightward from left band opens; left expanded→leftward from ANY origin closes; details closed→leftward from right band opens; details open→rightward (not from left band) closes. Panel state read from AppFrame attrs (`[data-sidebar-collapsed]`/`[data-details-collapsed]` absent = expanded). Defaults: distance 50, edgeBand 40, **velocity 0 (disabled — sidecarx parity)**, breakpoint 1024. touch/pen only, `|dx|>|dy|` required.
- Client-half config channel: `window.__DASHR_MOBILE__` page global set by same boot script (client bundle gets NO loader config).
- 4999 test topology: daemon `systemd-run --user --unit=dsh-4999-test` (binds 127.0.0.1 only; `--host 0.0.0.0` deliberately refused by launcher: "would expose remote code execution"); socat user unit `dsh-4999-lan` (0.0.0.0:4990→127.0.0.1:4999); env via `EnvironmentFile=.scratch/dsh-4999.env` (`DSH_TRUSTED_HOSTS=probe.example 192.168.31.130`); profile patch at `.dsh-test/profiles/web/cordis.patch.yml` sets `trustedPageAuthorities: ['probe.example','192.168.31.130']`.
- **NEW unresolved**: user accesses via `test.pc.randomhash.app` — a hostname NOT in trustedPageAuthorities (only `probe.example`, `192.168.31.130`) → boot script does NOT flip ownsHost for it → isLoopback stays false → Models fails. Also `test.pc.randomhash.app` must resolve/proxy to 4999 somehow (unknown — Caddy edit forbidden without approval; DNS/Caddy routing for test.* unverified). MUST check `.scratch/dsh-4999.log` + Caddy config to see what actually happened.
- CDP probe: `.scratch/cdp-probe.mjs` (ws@8.21.0 from monorepo `.pnpm`; chrome must run via systemd-run user unit `dsh-cdp-chrome` — killed inside sandbox exit 143). Verified via 192.168.31.130:4990: `__DSH_TRANSPORT={ownsHost:true}`, Models renders "DeepSeek / Edit / Add provider". User challenges probe reliability — wants cross-machine verification via Hermes/OMP agents (A2A: `mcp__cordis-a2a__a2a_send` to Hermes; DEV3 OMP via a2a too).
- `dsh-better-sidebar`: 0.17.1 incompatible with alpha.5 (`settingsNamespace` export removed); 0.18.0-alpha.0 installed OK; install = `dsh plugin --profile web add --config.auto-install-peers=false <pkg>`; profile pnpm-workspace needs `allowBuilds: node-pty: true` + `pnpm rebuild node-pty`.
- RPC replay for diagnosis: `POST /api/<ns>/<method>`, body `{"type":"client-request","rpcId":"x","method":"<ns>/<method>","payload":{"args":{}}}` — slash namespacing.

## Files and Code
- `dashr/src/web-trust.ts` (NEW, host half): `buildBootScript(config)` pure fn + `installWebTrust(ctx, config)` — `webserver/index-inject` listener; script sets `__DSH_TRANSPORT__` (no-overwrite guard, JSON-embedded authorities, `{ownsHost:true}` only) + `__DASHR_MOBILE__`; mobile default-ON; malformed authority (port/path/empty) throws `/bare hostname/`.
- `dashr/src/mobile/gesture.ts` (NEW, pure): `classifySwipe`, `isInteractiveOrigin`, `isNarrowViewport`, `resolveMobileConfig`, `DEFAULT_SWIPE_THRESHOLDS={breakpoint:1024,swipeDistancePx:50,swipeVelocityPxPerMs:0,edgeBandPx:40}`; velocity gate only when `>0`.
- `dashr/src/mobile/client/index.ts` (NEW, client half): `setupMobileLayout(ctx)` — style tag (`data-plugin`/`data-plugin-css='@pgmi-builds/better-dsh/mobile'`, media query `[data-sidebar-collapsed]{grid-template-columns:0px minmax(0,1fr) 0px !important}`), pointer listeners → `classifySwipe` → `toggleSidebar()/openDetails()/closeDetails()`; `ctx.inject(['layout'],…)` conditional.
- `dashr/src/index.ts`: Config += `trustedPageAuthorities?: string[]`, `mobile?` (schema via `MOBILE_CONFIG` const; whole schema cast `as unknown as z<Config>` for schemastery intersect inference); apply += `installWebTrust(ctx, config)`.
- `dashr/src/failover/client/index.ts`: client entry mounts `setupMobileLayout(ctx)`.
- `dashr/cordis.patch.yml`: += connection row override (fence leg).
- `dashr/package.json`: version `0.2.1-f`; `dsh.client.inject` += `@deepseek-ai/dsh-client-ui-layout`.
- `dashr/tsconfig.json`: exclude += `src/mobile/client` (client-half convention).
- Tests: `dashr/test/web-trust.spec.ts` (8), `dashr/test/mobile-gesture.spec.ts` (10) — 429/429 total.
- `.scratch/cdp-probe.mjs`, `.scratch/dsh-4999.env`, `.scratch/models-page-proof.png` (screenshot proof).
- `.dsh-test/profiles/web/cordis.patch.yml`: dashr-repl row override w/ trustedPageAuthorities (currently `['probe.example','192.168.31.130']` — **missing `test.pc.randomhash.app`**).
- `docs/50_test-reports/v0.2.1f-plugin-shipped-ui-patches实测报告.md`: rounds 1-3 appended.
- OpenSpec change dir + skill `.agents/skills/dsh-plugin-development/` + AGENTS.md §四 — all updated through round 3.
- Reference: `~/workspaces/sidecarx/src/webclient/src/app.js:332` (SWIPE_THRESHOLD=50, band 40, no velocity), `components/overlay-viewer.js:226`.

## Errors and Fixes
- `!!js` leading-`[` → YAML flow-seq rejection: use `(process.env.X ?? '').split(/\s+/).filter(Boolean).concat(ctx.webRuntime.trustedHosts)`.
- Duplicate Config schema blocks from edit collisions in `src/index.ts` (twice) + missing `swipeDistancePx` line: fixed by careful re-reads.
- Headless chrome killed in sandbox (exit 143): run via systemd-run user unit outside sandbox.
- `--host 0.0.0.0` refused by launcher (intentional upstream safety): socat LAN proxy instead.
- `systemd-run` with spaced env value → "Invalid environment block": use EnvironmentFile.
- Left-swipe-to-close never fired (round 2): root cause = origin edge-band-only condition rejected swipes starting on the overlay body; fixed with panel-aware classifier (expanded→any origin).
- Velocity 0.35 "too fast" (round 2) → 0.2; round 3 → sidecarx has NO velocity gate → default 0.
- better-sidebar 0.17.1 crash on alpha.5 (`SyntaxError: ... does not provide an export named 'settingsNamespace'`) → 0.18.0-alpha.0.
- **User round-3 corrections (unresolved)**: (1) I claimed user's phone hit prod without checking logs — user says phone+MacBook hit **test.pc.randomhash.app**; must check daemon log/Caddy before asserting; (2) my own headless-chrome probe is not trusted as evidence — must get independent browser verification from Hermes (another machine) or DEV3 OMP; (3) must answer whether `isLoopback`/`__DSH_TRANSPORT__` is read once (constant at apply) or re-evaluated — source says once at apply (`client/index.ts:228`, literal property; `$host` snapshot at gateway apply), so late loading is irrelevant for the WRITE side, but the question deserves a precise evidence-backed answer.

## Pending Jobs
- **Diagnose `test.pc.randomhash.app` path**: check `.scratch/dsh-4999.log` + how test.pc.randomhash.app routes (DNS? Caddy? port?) to 4999/4990; likely fix = add `test.pc.randomhash.app` to `trustedPageAuthorities` (and DSH_TRUSTED_HOSTS for the fence), then verify Models on phone/MacBook.
- **Cross-machine browser verification** via A2A: send test request to Hermes agent (another machine) and/or DEV3 OMP to load the URL and report the Models page + swipe behavior.
- Answer the mutability question with source evidence (already have: read-once-at-apply; write up precisely).
- User re-test: Models page, left sidebar swipes (sidecarx-tuned), right panel swipes + better-sidebar, via test.pc.randomhash.app.
- Change closure: tasks 1.5/2.2/2.4 (device-level confirmations), archive, publish/prod deploy (age-gate exact-version flow) — not yet requested.
- Cleanup: chrome unit stopped; socat `dsh-4999-lan` + daemon running.

## Current Work
Round 3 had just been committed (gesture defaults aligned to sidecarx: 50/40/velocity-0; CDP probe proof via 192.168.31.130:4990; tag `v0.2.1f` moved; memory stored) when the user replied with the round-3 corrections: they tested via `test.pc.randomhash.app` from phone AND MacBook (Models broken both), demanded log-checking before instance claims, cross-machine verification via Hermes/OMP, and the variable-mutability answer. No diagnostic action taken yet on these three demands.

## Next Step
Check `.scratch/dsh-4999.log` (and Caddy/DNS routing for `test.pc.randomhash.app`) to confirm what the phone/MacBook actually hit; then add `test.pc.randomhash.app` to `trustedPageAuthorities` (+ `DSH_TRUSTED_HOSTS`), restart, and dispatch cross-machine browser verification to Hermes/OMP via A2A — while answering the mutability question (isLoopback computed once at connection apply; `$host` snapshot at gateway apply; boot script wins because it runs before bundle materialization).

## Critical Context
- 4999 daemon running (token `EWiadkBZ3i2lZ307BBjk1ly4o7v3nrX3Rc1ozyxC0Es`), socat 0.0.0.0:4990→127.0.0.1:4999, better-dash 0.2.1-f round-3 build deployed.
- `test.pc.randomhash.app` is NOT in any trust list — if it reaches 4999, fence (server) would 403 `/api` and boot script won't flip isLoopback: BOTH legs fail on that hostname; that is consistent with user symptoms on phone AND MacBook.
- User communication: terse, furious at unverified claims; ALWAYS check logs/evidence first; use remote agents (Hermes/OMP via `mcp__cordis-a2a__a2a_send`) for independent verification; never suggest upstream PRs; never reduce better-dsh to "a REPL".
- The mutability answer (source-verified): `isLoopback` is a plain property computed once in the connection client's `apply()` (`client/index.ts:228`); gateway snapshots `{home, isLoopback}` into hostFacts; ui-settings reads it once at its apply. No per-call re-evaluation. The boot script's head-inline position (before shell main script at HTML offset 23778 < 25168) guarantees it precedes all plugin applies.
- Local git: commit history through round 3, tag `v0.2.1f` (local only, never pushed).
```

### 观察要点

1. **粒度是「任务叙事级」，不是逐 item**：8 段把 559 items（约 35 万 token）咀嚼成 ~12.5K chars（≈3.5%），信息压缩比 ~28:1。用户指令被逐条意译保留（含裁决原话的英文转述），但**无法从摘要定位到具体某条 tool result / 某轮 assistant 正文**——这正是「语义连接、无更细粒度寻址空间」的实证。
2. **结构化程度高且段固定**：8 个 `##` 段名跨 episode 完全一致（模板化产出），段内 bullet 列表，文件路径、配置键、版本号、commit hash 等锚点密度高——适合做 ctx://compacted/{label} 清单页的预览素材（如截取 `## Primary Request and Intent` 前 3 行）。
3. **摘要与原文的关系是语义聚合**：`## Files and Code` / `## Errors and Fixes` 等段实为对 §10.2 工具分布（159 bash / 48 read / …）结果的叙事化收编；要回看某条具体命令输出或某次 read 的完整内容，只能靠原文层（context:transcript / tool_calls 子资源）。

## 12. 嵌套压缩的可见性实证 + 源码不变量（2026-09-04 增补）

**问题**：多次压缩后，模型是否永远只能看到最新一个 checkpoint，而不会在同一 turn 同时看到 Checkpoint 1 和 Checkpoint 2 的 summary？

### 12.1 Surface 投影模拟（按 surfaceOp 语义逐事件重放）

| 时点 | surface items | 可见 checkpoint |
|---|---|---|
| EPISODE-1 之后 | 2 | `[109246]`（仅 CP1） |
| EPISODE-2 之后 | 3 | `[221218]`（仅 CP2，CP1 被 replace [109246..220120] 移出） |
| 下一次模型调用（turn-24 request/header） | 7 | `[221218]` |
| log 末尾 | 437 | `[221218]` |

**结论：任意时刻 surface 上最多只有一个 checkpoint，且永远是最新的那个。** 模型对更早 checkpoint 的存在毫无感知——既不知道有几个，也不知道还能回溯。

### 12.2 源码级不变量（head-anchored selection）

`compaction-basic/src/region.ts` `selectCompactableRange`（唯一选区函数）：

```ts
const first = surfaceNodes[0]!          // 区间起点 = 整个 surface 的第 0 个节点
const cutoff = surfaceNodes[keepFromIdx - 1]!
return { start: first, end: cutoff }    // 头锚定：从 surface 头部到保留尾之前的全部
```

任一次压缩后，checkpoint 节点即成为 surface 头部（其前方的旧区间已被整体替换），因此**下一次压缩的选区必然从上一个 checkpoint 开始**——"只留最新"不是巧合而是构造性不变量。

### 12.3 Summarizer 的输入构成（信息金字塔）

EPISODE-2 摘要模型实际输入 = inputTokens 379 + cacheRead 413,568 = **413,947 tokens ≈ 整个被压缩 span（含 Checkpoint-1 节点本身**，shadowedSeqs[0]=109246）。即：

```
CP2.summary = chew( CP1.summary + CP1之后的新历史 )     ← 原始一级内容不再进入摘要
```

信息逐级有损重咀嚼（original → CP1 → CP2）。要拿 CP1 之前的原始内容，唯一路径是经 CP1 自己的 `compaction/summary.shadowedSeqs` 回溯——正是 manifest 必须暴露链关系的原因。

### 12.4 设计落点（本轮裁决）

1. **挂 hook 打标签**：compaction 事务提交后（compaction/end 之后）plugin 侧 `session.append` 一个单节点 replace（`start===end===checkpoint seq`）在 checkpoint 尾部追加 `[recallable via ctx://compacted/<id>]` 指令行——机制即上游改写历史同款，alpha.5 下依旧合法。
2. **标签用不可变 id**：⚠ 若用 replace 改写 checkpoint 节点，新节点会获得**新 seq**——checkpoint 节点 seq 会被我们自己的打标签操作漂移。地址键应使用**不漂移的坐标**：`compaction/summary` 事件的 seq（log-only 永不被 replace）或 `compactionId`。建议：地址 = summary seq（短、有序、immutable），compactionId 在 manifest 里作绝对唯一键兜底。
3. **manifest 必须显式标注嵌套链**：每个条目给出 `{summary-seq, 时间, token量, 8 段各前 100 字预览, replaces: 上一 checkpoint 的 summary-seq}`；模型据此既可调更早的 summary，也可下钻任一 checkpoint 的 shadowedSeqs 原文。
4. 跨会话合并寻址不占本特性范围（长时记忆归 Corti）。
