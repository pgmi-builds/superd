# agent-worlds Five-Adapter Parity Fixes (2026-09-17 hand-test findings)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every finding from the 2026-09-17 five-adapter (omp/codex/claude/pi/hermes) hand-test on the 4999 line: session-log download 404 (all), transcript typed-event gaps (claude/codex/hermes), model catalogs (pi/hermes provider grouping + hermes length, claude single-model), resume failures (hermes wedge, codex unmigrated maps), claude permission-policy bounce-back + missing preset roster, and turn-usage rendering (claude partial, codex/hermes none).

**Research basis:** five root-cause reports (2026-09-17, in-session). Root causes below are condensed with file:line evidence; executors re-verify before editing.

**Out of scope this round:** `tool/result.meta` rich tool cards (no adapter emits meta today), claude subagent display slots (`parent_tool_use_id` count-only), file-upload/pdf-worker URL shims, any agent-omp change (omp is the working reference).

---

## Root causes (condensed)

### RC-1 Session-log download 404 (all adapters)
- Browser client `session-log-export/src/client/controller.ts:70,115`: builds `new URL('/api/session.export', location.origin)` — absolute, no mount prefix → hits ctx0 root → 404. Fetcher resolves `fetch` at call time (`:70`); download anchor consumes the same URL (`:123` → `downloadUrl` `:40-44`).
- Backend reachability is ALSO missing: carrier `/<label>/api` is RPC-envelope-only (`agent-hub/src/carrier.ts:159-161`, GET/HEAD → 400) and world route registrations are swallowed (`agent-hub/src/world-web-server.ts:160`). The world's own `session-log-download` plugin (composed via the web-app bundle patch, upstream `packages/bundle/web-app/cordis.patch.yml:60`) is the correct answerer once reachable.
- **User ruling (2026-09-17): patch the BROWSER side to fetch `/<label>/api/session.export`; no ctx0-root carrier bridge.** The small carrier passthrough (forward non-envelope GET/HEAD into the world's registered fetch routes) is a required dependency, else the patched client gets 400 instead of 404.

### RC-2 Transcript typed events (claude/codex/hermes)
- Durable logs are already name-typed in current sources; the hand-test ran pre-rebuild builds (claude `agent.ts` rewritten 19:51 Sep 16 AFTER the 19:47–20:49 test window; hermes `agent.ts` Sep 17 09:03). UI "N tool calls" collapse = `turn-process.ts:117-121` when a step has tool events but no visible assistant content.
- Definitive source gaps: **claude never emits `system/message`** (zero hits in `agent-claude/src`), no live `agent/assistant-stream` bridge, no `request/context`; `TodoWrite`/`todo_list`/`todo.updated` all fall to generic tool pairs instead of `todo/write`; hermes `session.title` capture-only; claude thinking shape `{type:"thinking",thinking}` not recognized (`textOf` pins `{type:"reasoning",text}`, `claude-events.ts:31-44`); claude `compact_boundary` + `permission_denied` trace-only.
- DSH vocabulary: dev-rules §11 + `[dsh]/core/session/src/types.ts:269-400` (surface events = `system/message`, `user/message`, `assistant/message`, `tool/result` only). Reference projections: omp/pi (`agent-pi/src/agent.ts:515-566,830-905`, `pi-events.ts`).

### RC-3 Model catalogs
- pi/hermes: catalogs carry real per-model providers, but each adapter registers ONE umbrella route (`PI_PROVIDER_ID="pi"` `models.ts:26` / `HERMES_PROVIDER_ID="hermes"` `adapter.ts:33`) and re-brands every entry, collapsing everything into one group. omp is the reference: `registerAdapter(distinctRealProviders)` + per-route `listModels` filter (`agent-omp/src/models.ts:85-112`, `index.ts:326-338`). dsh-llm supports atomic route swap post-boot: `AdapterRegistrationHandle.replace(providers[])`.
- hermes length: the auth filter ALREADY exists (`models.ts:140`, `authenticated !== true` drops) — the gateway reports all 17 endpoints authenticated (≈579 models: qwen-cn 252, ark 133, openrouter 47, …). Grouping by slug + trims is the fix; stricter filtering would need gateway support that doesn't exist.
- claude: `BOOT_CATALOG` is a single frozen `sonnet` entry (`models.ts:54-62`); growth only via `observeModelCatalog` after a live session starts (`agent.ts:769-780`) via `query.supportedModels()` (CLI initialize response `models: ModelInfo[]`, `sdk.d.ts:4035-4040,1266-1307`). Host CLI 2.1.261 carries aliases `sonnet,opus,haiku,fable,best,sonnet[1m],opus[1m],fable[1m],opusplan`. No boot-time probe exists (hermes probe pattern: `agent-hermes/src/index.ts:163-169`).

### RC-4 Resume failures
- hermes: NOT a resume-handshake bug (`session.resume {session_id: storedId}` is sent correctly, `hermes-client.ts:401-403`). The Dash host eagerly resumes agents on session *view* (`promote()` → `factory.resume()` → `spawn()` at `index.ts:400`); the client's 10-min spawn-grace reaper (`hermes-client.ts:75,298-306`) then closes the never-materialized client; `close()` stamps terminal failure "hermes gateway client closed" (`:514`); the agent stays registered with a dead client (`#markIdle` early-returns, `agent.ts:757-758`) → every later prompt fails with code `UNKNOWN` (`agent.ts:557,813`). Permanent wedge; self-heals only via the idle-exit path that never arms.
- codex: `resolveCodexStateDir` (`session-map.ts:76-89`) reads only the NEW anchor (world-home root); old maps deliberately unmigrated (user decision 2026-09-17) → pre-re-anchor sessions hard-throw at `factory.resume()` (`index.ts:402-404`) = the reported "some not resumable". Secondary: C4 rollouts stranded under abandoned `<worldHome>/.codex` fail at first turn (zero-IO `resumeThread`); C6 `followThreadId` unsubscribes after first capture (`index.ts:498-524`) while `newSession()` swaps threads.

### RC-5 Claude permission policy + preset
- Bounce-back: `bootstrapSessionIdentity` (`agent.ts:664-684`) unconditionally re-stamps create-time `permission/preset` + `setPermissionMode` at first turn, overwriting any choice made in the blank window; resume prefers the map's stale `preset` over the log fold (`index.ts:338-346`); `onModeChange` upserts only `claudeMode`, never `preset` (`index.ts:293-296,402-405`) → dual-store divergence. (Mode mapping itself is correct: `permission.ts:44-48`.)
- Preset: claude ships neither `agent-preset-claude.ts` nor `agent-preset-projection.ts` while stamping `agent-preset/selected` (`agent.ts:669-670`) into a log nothing folds; `agentPresets/list` 404s (patch disables upstream `agent-presets`, and the adapter never re-registers the roster+projection halves its four siblings ship). Header label renders null/degraded.

### RC-6 Turn usage (client fold: `[dsh]/llm/token-meter/src/turn-usage.ts:81-120,178-298`)
- Panel data is DERIVED per turn from durable events; requires usage on a message of the SAME turn and `normalizeUsage` needs `totalTokens` or BOTH cache buckets; `reasoningTokens > outputTokens` is rejected (Dash: reasoning ⊆ output).
- claude: usage only on `result` (`claude-events.ts:145-154`), assistant branch drops per-message usage; mid-turn flush (`tool_start`) closes the attempt with no sample → invalid for every tool turn; `pendingUsage` leaks across turns.
- codex: usage only on `turn.completed`, consumed by the NEXT turn's message (1-turn lag, `agent.ts:28-30,924,995`); `reasoning_output_tokens` is ADDITIVE to output → `reasoningTokens > outputTokens` → rejected always.
- hermes: usage placed correctly but `convertUsage` (`agent.ts:193-206`) sets no `totalTokens` and the gateway shape has no cache buckets → `normalizeUsage` returns undefined every time.

---

## Design Rulings

1. **Browser-side patch for session.export (user ruling 2026-09-17)** — client shim rewrites absolute `/api/*` to the mount prefix; NO ctx0-root carrier bridge. The carrier passthrough is generic hub mechanism (§12: hub provides mechanism), not a world-resolving answerer.
2. **No agent-omp changes.** omp is the reference implementation for models and event projection.
3. **Old codex maps stay unmigrated** (user decision). Recovery is per-session on-demand discovery against the CURRENT native home (`~/.codex`), never a bulk import; stranded old-home rollouts fail closed with a stable code.
4. **Hermes self-heal over lazy-spawn** for this round: dispose the agent on client-terminal failure (host re-resumes fresh on next prompt) AND stop the spawn-grace reaper from killing agent-held clients. Full lazy spawn (no child at view-time) deferred.
5. **Claude log fold is the permission authority** at first turn; the map keeps only the mode cache; extra tiers (`plan`/`auto`/`dontAsk`) stay mode-only.
6. **Usage algebra targets omp/pi shape**: per-attempt-provable sample on the same turn, `totalTokens` synthesized from each runtime's own counters, no invented cache tokens.
7. **Upstream source zero-modification; exact pins; TS-private discipline; `npm run build` (tsc) then `node --test test/*.mjs` per package; tests import `dist/`; isolated homes via mkdtempSync; env knobs for native homes.**
8. Per dev-rules §12, every adapter decision above is recorded here and in the adapter docs; hub provides mechanism only.

---

## Wave 1 — parallel per-package tasks (disjoint file scopes)

### Task H1 (agent-hub): client-shim URL rewrite + carrier fetch passthrough

**Files:** `apps/agent-worlds/agent-hub/src/client-shim.ts`, `apps/agent-worlds/agent-hub/src/carrier.ts` (+ `world-web-server.ts`/`world-mux.ts`/`gateway.ts` as the passthrough requires), tests in `apps/agent-worlds/agent-hub/test/`.

- [ ] **client-shim**: after the existing injection block (~line 98), add (a) `globalThis.fetch` wrapper — rewrite URLs whose origin+path start with `/api/` to `<mountBase>/api/…` (label comes from the mount config, NOT pathname parsing; preserve query + hash; leave same-mount and foreign URLs untouched); (b) capture-phase `click` listener rewriting `a[href]` through the existing `rewriteUrl` (covers the download anchor at `controller.ts:123`). Injected only into world pages (existing first-head-script path, `world-web-server.ts:264`) — ctx0 pages untouched by construction.
- [ ] **carrier passthrough**: extend the `/<label>/api` handler: non-envelope GET/HEAD requests forward into the owning world's registered `connection.fetch` routes (bridge through the world gateway's unary channel; respect ctx0's auth fence exactly like existing mount traffic). `HEAD /<label>/api/session.export?sessionId=…&includeDescendants=true` must return the world plugin's ZIP response (200) and unknown world routes 404.
- [ ] Tests: shim rewrite (absolute `/api/x?y` → `/​<label>/api/x?y`; non-`/api` untouched; anchor href rewrite); carrier passthrough (fake world route registered via the gateway bridge; envelope RPC still works; GET/HEAD forwarded; auth fence applied).

**Interfaces:** no exported API changes; world pages keep `__DSH_TRANSPORT__` semantics.

### Task C1 (agent-claude): system prompt, stream bridge, typed upgrades, usage, permission, preset

**Files:** `agent-claude/src/{claude-events.ts,agent.ts,claude-client.ts,index.ts,permission.ts,models.ts}` + new `agent-preset-claude.ts`, `agent-preset-projection.ts`; tests `agent-claude/test/*`.

- [ ] **`system/message`** (port pi `agent-pi/src/agent.ts:515-542`): stamp once per session into the first open step. Prompt source precedence: SDK-provided (inspect `SystemInitMessage`/initialize response for a prompt field; use it if present) → else adapter-generated factual text, clearly labeled `(agent-claude adapter)`: model, cwd, permission mode. Skip on resume.
- [ ] **`request/context`** per model route change (pi `:545-566` pattern; provider `claude`, observed model, contextWindow if known).
- [ ] **Live stream bridge**: port pi's AssistantStreamBridge (`agent-pi/src/agent.ts:108-149`); if the SDK surfaces no deltas, emit the bridge frames when each assistant message arrives so text is visible before `tool_start` flush. Keep `stream: []` → filled records in the final `assistant/message`.
- [ ] **Thinking shape**: `textOf` accepts `{type:"thinking",thinking}` alongside `{type:"reasoning",text}` (`claude-events.ts:31-44`); update `test/claude-events.test.mjs`.
- [ ] **`todo/write`**: `TodoWrite` tool calls ALSO emit `todo/write` (whole-list snapshot, latest-wins) — keep the tool pair.
- [ ] **`compaction/*`**: `system{compact_boundary}` → `compaction/start|end` bracket (replace trace-only `agent.ts:932-936`).
- [ ] **Usage** (RC-6): project `body.usage` on `assistant` wire events (`claude-events.ts:97-114`); attach at every flush incl. tool_start; DELETE `pendingUsage` cross-turn stash (`agent.ts:710-720`); `convertUsage` sets `totalTokens = input + cacheRead + cacheWrite + output` (`agent.ts:103-118`); `source.model` uses the observed model (`agent.ts:822-825`), not `options.model ?? ''`.
- [ ] **Permission** (RC-5): `bootstrapSessionIdentity` resolves `presetFromEvents(snapshotEvents()) ?? runtimeInfo.preset` and skips BOTH the stamp and `setPermissionMode` when the fold already carries a revivable preset; resume takes `presetFromEvents(cold.events) ?? defaultPermissionPreset(ctx)` with `record.claudeMode` only as mode cache; `onModeChange` upserts `{claudeMode, preset}` together (inverse map in `permission.ts`; extra tiers = no preset change); extend the `session/event` listener to also reconcile on `sandbox/mode`/`approval/policy`.
- [ ] **Preset roster + projection**: port `agent-pi/src/agent-preset-{pi,projection}.ts` → `agent-preset-claude.ts` (`{id:'claude', trust:'system', name:'Claude', …}`, frozen, full `@Remote` set) + `agent-preset-projection.ts` (`init: header?.agentPreset ?? 'claude'`); register BOTH on the provider's top-level fiber in `index.ts` (next to `setFactory`, ~`:216`) — never under `ctx.plugin`. Update `test/verify-claude-app.mjs:38-40` (404 no longer expected).
- [ ] **Boot model probe** (RC-3): minimal SDK query (streaming-input queue, NO prompt) → `query.supportedModels()` → `setModelCatalog(mapped, default)`; fire-and-forget at provider boot after `registerAdapter` (`index.ts:421-424`); map `ModelInfo` via `modelEntryFromSdk` extended with `resolvedModel` (description suffix) + `supportedEffortLevels` → `reasoning` efforts; leave `contextWindow` unset; keep `sonnet` only as probe-failure fallback; reword the `observed-only` invariant comment (`models.ts:8-21`).
- [ ] Tests: fold fixture test — run upstream `@deepseek-ai/dsh-token-meter` `deriveTurnTokenUsage` over emitted event sequences for (a) text turn, (b) tool turn → defined usage both; permission tests (blank-window choice survives first turn; resume uses log fold; onModeChange keeps stores equal); preset tests (roster resolve/read, projection fold); events tests (thinking shape, todo/write, compaction bracket, system/message once-per-session); probe test (mock query → catalog grows past sonnet).

### Task X1 (agent-codex): todo/write, usage fold, resume robustness

**Files:** `agent-codex/src/{codex-events.ts,agent.ts,index.ts,session-map.ts,codex-store.ts}`; tests + fixtures in `agent-codex/test/`.

- [ ] **`todo/write`**: `item.todo_list` ALSO emits `todo/write` (keep tool pair).
- [ ] **Usage** (RC-6): land `turn.completed.usage` on a message of the SAME turn — defer the turn's final `assistant/message` append to `turn_end` (preferred) or emit a `'usage'` stream chunk on the turn's last message at `turn_end`; remove `#pendingUsage` cross-turn consumption (`agent.ts:924,995`); `convertUsage` (`agent.ts:181-196`): synthesize `totalTokens = input + cachedInput + cacheWrite + output + reasoning` from codex's own counters; include `reasoningTokens` only when ≤ `outputTokens` (codex reasoning is additive).
- [ ] **Resume pre-validation**: in `resume()`, before spawning, `readRolloutHead(resolveCodexHome(), threadId)` → `undefined` ⇒ fail closed with code `ROLLOUT_MISSING` (covers home-switch stranding + pruned rollouts at resume time, not first-turn).
- [ ] **C1 discovery (on-demand, current home only)**: when the map entry is missing, scan `~/.codex/sessions/**/rollout-*.jsonl` heads: match rollout `cwd` against the DSH session header cwd AND match the DSH log's first `user/message` text against the rollout body; unique match → adopt thread id, `upsertSession`, resume; ambiguous/none → stable code `SESSION_MAP_MISS` ("predates the identity-map re-anchor"). Never scan the abandoned `<worldHome>/.codex` tree.
- [ ] **C2/C6/classification**: `threadId: null` → stable code `NATIVE_THREAD_NEVER_STARTED` (no auto-fresh-thread); `followThreadId` re-arms on change (upsert whenever `client.threadId` differs) instead of unsubscribing after first capture (`index.ts:498-524`); map turn-time native errors to codes (`ROLLOUT_MISSING`, `NATIVE_REJECTED`) and mark `resumable: false` in the map after a native resume rejection so later prompts fail fast with a clear error.
- [ ] Tests: discovery matcher (unique/ambiguous/none; cwd+first-message match), pre-validation (missing rollout → ROLLOUT_MISSING at resume), followThreadId re-arm, fold fixture test over `thread-events.sample.json`-shaped events (text turn + tool turn), todo/write projection.

### Task M1 (agent-hermes): slug groups + trims, typed upgrades, usage, resume self-heal

**Files:** `agent-hermes/src/{adapter.ts,index.ts,models.ts,hermes-events.ts,hermes-client.ts,agent.ts}`; tests + `gateway-rpc-samples.json`/`gateway-events.sample.json` fixtures.

- [ ] **Model grouping** (RC-3): routes = distinct `entry.provider` slugs; register placeholder at boot (`index.ts:293`) then `handle.replace(slugs)` after the first catalog probe resolves; `listModels(provider)` filters by `entry.provider`; ids stay VERBATIM gateway selection strings (wire contract, `models.ts:14-16`); `providerInfo(slug)` serves the row's human `name` via a module-level last-known-catalog cache (capitalize fallback pre-fetch); default-model push (`index.ts:264`) + `routeContext` (`index.ts:218-227`) switch to `{provider: slug, model: id}`.
- [ ] **Trims**: drop `source: "virtual"` rows; collapse mirrored endpoints whose model-id sets are identical (copilot vs copilot-acp); featured-first ordering for endpoints > 50 models (`featured_models`, then rest alphabetical). Document in adapter docs (§12).
- [ ] **`todo/write`**: `todo.updated` → `todo/write` (currently projector null, `hermes-events.ts:259-263`).
- [ ] **`session/title` mirror**: `session.title` → `session/title {title, messageSeqs: [], source:{kind:"provider",provider:"hermes"}}` (pi `:877-905` pattern); keep client-side capture.
- [ ] **Usage** (RC-6): `convertUsage` (`agent.ts:193-206`) sets `totalTokens`: use gateway `total` only if fixture analysis shows per-message semantics; else synthesize `input + output (+ reasoning if ≤ output)`. No cache tokens invented (cache rows legitimately hidden).
- [ ] **Resume self-heal** (RC-4): add `usable`/`closed`/`failed` getters on the client; `HermesAgent` onFailure path: client-terminal failure && not disposed ⇒ `#onIdleExit?.()` full dispose (host re-resumes fresh on next prompt); spawn-grace reaper (`hermes-client.ts:298-306`) must NOT reap agent-held clients (grace applies only to the self-closing probe client); classify turn-error codes: gateway 4001/4006 → `NATIVE_SESSION_GONE` (+storedSessionId), child exit → `GATEWAY_CRASH`, closed client → `CLIENT_CLOSED`; after `#adoptSession`, tolerate `stored_session_id` drift (remint + upsert).
- [ ] Tests: slug grouping + trim rules (fixtures), providerInfo cache, todo/title projection, usage conversion fixture (`gateway-events.sample.json`), self-heal (client failure → disposed → next resume spawns fresh), reaper scope (agent-held client survives grace), fold fixture test (text + tool turn).

### Task P1 (agent-pi): real provider routes + selection threading

**Files:** `agent-pi/src/{models.ts,adapter.ts,index.ts,agent.ts,pi-client.ts}`; tests.

- [ ] **Routes**: after `warmPiCatalog()`, compute distinct slugs from `PiCatalogModel.provider`; `handle.replace(slugs)` (placeholder single-route register at `index.ts:234` stays for boot); `listModels(provider)` filters by `entry.provider`; serve the BARE `modelId` per route (omp parity); `providerInfo(slug)` display names (titles map + capitalize, omp `models.ts:109-112` pattern).
- [ ] **Selection threading**: `#syncModelSelection` passes `{provider, model}` (`agent.ts:603-625`); `pi-client.ts:201-217` `setModel(provider, modelId)` → `runtime.getModel(provider, modelId)` directly (composite-split path stays only for legacy stored selections); route-pin sites switched to the real slug pair: default push `index.ts:256`, pinning `index.ts:149-153`, `routeContext` `index.ts:186-205`.
- [ ] Tests: slug grouping; per-route filter (deepseek route lists only deepseek models); setModel threading reaches `getModel` with the right pair; legacy composite selection still resolves.

---

## Wave 2 — integration (owner: session lead, not subagents)

- [ ] Rebuild all: `npm run build` in agent-hub, agent-pi, agent-codex, agent-claude, agent-hermes (omp untouched; rebuild harmless if needed).
- [ ] `npm test` per package; all green or explicitly justified.
- [ ] Heal check: `find node_modules/@deepseek-ai -maxdepth 1 -mindepth 1 ! -type l` → only `dsh-client-ui-slots` physical.
- [ ] Restart 4999: `systemctl --user stop aw-4999-test` → `bash apps/agent-worlds/test/start-4999.sh`; verify roster 5/5 ready; curl each `/​<label>/` 200.
- [ ] Wire smoke: `HEAD /<label>/api/session.export?sessionId=<existing>` → 200 ZIP for at least omp + claude; model picker groups per adapter (needs UI or RPC check); a fresh claude session shows `system/message` node 0 and usage on a tool turn; hermes resume works after >10 min idle simulation (or with shortened `HERMES_SPAWN_GRACE_MS` in a probe run).
- [ ] Report + hand to user for hand-test acceptance (repo discipline: real runtime turn per fixed path).

---

## Verification matrix (hand-test re-check list)

| Finding | Expected after fix |
|---|---|
| download session log 404 (all) | ZIP downloads from every world |
| claude no system prompt | node 0 `system/message` present |
| all rendered as generic "tool call" (claude/codex/hermes) | typed names (current builds were already partially fixed; re-judge after rebuild) |
| pi/hermes `pi/deepseek-v4-pro` | real provider groups (DeepSeek/ZAI/…) |
| hermes list unusably long | grouped by provider; virtual dropped; mirrors collapsed; featured first |
| claude only sonnet | opus/haiku/fable-5/… from CLI probe |
| claude policy bounces back | selection persists across first turn + resume |
| claude preset "Claude" degraded | real roster + header label |
| hermes resume "gateway client closed" | works after idle; classified codes when native session gone |
| codex some sessions not resumable | pre-re-anchor sessions recover via discovery or fail with clear read-only code |
| usage missing (claude/codex/hermes) | Turn usage panel on text AND tool turns |
