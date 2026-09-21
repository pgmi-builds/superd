# @pgmi-builds/agent-adapter-hermes

Hermes provider for DeepSeek Harness (dsh) — an AgentFactory that embeds the
Nous Research Hermes Agent via the TUI gateway JSON-RPC (`python -m
tui_gateway.entry`) and bridges its session surface into Dash Agent/Session
contracts (Agent Worlds AW-H; parity round 2026-09-17 = Task M1 of
`docs/superpowers/plans/2026-09-17-aw-five-adapter-parity-fixes.md`).

## Layout

- `src/models.ts` — gateway `model.options` → Dash model catalog (trim rules,
  r4 id dedupe, provider-name cache, slug list). Pure + fail-soft.
- `src/adapter.ts` — `HermesLlmAdapter`: one route per real gateway provider
  slug; `providerInfo` display names; ids stay verbatim selection strings.
- `src/index.ts` — `HermesProvider` (AgentFactory): creation transaction,
  boot route registration + atomic swap, default-model push, session map.
- `src/agent.ts` — `HermesAgent`: wire→DSH event bridge, usage conversion,
  turn-error classification, resume self-heal, title/todo mirroring.
- `src/hermes-events.ts` — PURE gateway-event → omp-wire projector.
- `src/hermes-client.ts` — one client = one gateway child = one session
  (spawn/env/ready/turn-settle/approval bridge; liveness getters; adoption
  listener; opt-in idle-probe reaper).
- `src/hermes-store.ts` — `<dshHome>/agents/hermes/dsh-sessions.json` map.
- `test/` — imports `dist/`; build first (`npm run build`), then
  `node --test test/*.test.mjs`. The world-plugin smoke needs the repo farm:
  run with `DSH_HOME=<repo>/.tests` (it refuses prod homes).

## Per-adapter rulings (2026-09-17 M1; recorded per dev-rules §4/§12)

1. **Model grouping by real provider slug** (RC-3 fix). Boot registers the
   single placeholder route `hermes` (the selector stays alive while the async
   probe runs); when the first `model.options` probe resolves, the
   registration atomically swaps to the DISTINCT surviving provider slugs
   (`AdapterRegistrationHandle.replace` — validated in full, one synchronous
   section). `listModels(provider)` filters by the entry's own `provider`;
   `resolveModel` matches the (provider, id) pair. Model ids are NEVER
   reformatted: they are the gateway's verbatim selection strings
   (`session.create {model}` / `/model <id>` consume them as-is — wire
   contract). The default-model push and the per-session route pin
   (`model/selection`, `request/context`) carry `{provider: slug, model: id}`,
   canonicalized through the catalog entry (the r4 dedupe gives every id ONE
   provider route, so a pinned route always resolves).
2. **Catalog trims** (the "579-model wall" fix), applied at mapping time in
   `mapHermesModelOptions`:
   - `source: "virtual"` rows drop (the `moa` synthesizer is not a selectable
     endpoint);
   - mirrored endpoints with IDENTICAL model-id sets collapse onto one row —
     first in gateway order wins, except a later `is_current` mirror displaces
     a non-current winner (fixture: `copilot`/`copilot-acp`,
     `zai-plan`/`zhipu`; 17 providers → 14 groups, 579 → 526 listed ids);
   - endpoints with MORE than 50 models reorder `featured_models` first
     (gateway order), remainder alphabetically; smaller rows keep gateway
     order (the 47-model openrouter row is untouched).
   The `authenticated !== true` filter predates this ruling and is unchanged.
3. **Cross-provider id dedupe stays (r4)**: an id listed under several slugs
   keeps ONE canonical route (first surviving row, current-row preferred).
   Rationale: the wire sends only the model id, so a duplicate listing would
   fabricate provider-specific selection the gateway cannot honor; canonical
   routes keep every pinned route resolvable. Consequence: multi-homed ids
   (e.g. `kimi-k3` under copilot/qwen-cn/kimi-cn) list under their canonical
   route only.
4. **`todo/write`** (typed transcript): the gateway's whole-list
   `todo.updated {todos, revision}` snapshot → wire `todo_updated` (projector;
   DSH-shaped items: trimmed content, status ∈ {pending, in_progress,
   completed}; `cancelled`/unknown statuses and duplicate/blank content drop —
   the DSH `todo/write` invariant has no cancelled status and forbids
   repeats) → the agent appends the log-only `todo/write {todos}` snapshot,
   only inside an open turn (upstream invariant), latest-wins. Log-only
   semantics kept (upstream `tool-todo` contract); the todo tool pair still
   renders through `tool_execution_*` as before.
5. **`session/title` mirror**: gateway `session.title {session_id, title}` →
   wire `session_title` (pi wire parity) → `session/title
   {title, messageSeqs: [], source:{kind:"provider", provider:"hermes"}}`,
   deduped, fail-soft, never affects the turn. The client-side `session.info`
   title capture stays (feeds `session.create`'s title + tracing).
6. **Turn usage** (RC-6 fix). Fixture verdict (`gateway-events.sample.json`
   index 13): the gateway's `total` is CONTEXT-WIDE, not per-message —
   `total 26805 = prompt 26803 + completion 2` and `prompt === context_used`
   (the whole re-sent window), so trusting it would inflate every turn.
   `convertUsage` therefore synthesizes the per-attempt-provable
   `totalTokens = inputTokens + outputTokens` (fixture: 19251 + 2 = 19253),
   which the DSH token-meter fold accepts (`normalizeUsage` needs `totalTokens`
   or BOTH cache buckets; the gateway shape has none — the pre-fix sample
   folded to `undefined` every turn). `reasoningTokens` rides only when
   `reasoning ≤ output` (Dash: reasoning ⊆ output; the fold rejects larger
   values). No cache tokens are invented (the gateway reports none —
   `cache_hit_pct` is a percentage).
7. **Resume self-heal over lazy spawn** (RC-4 fix, ruling 4 of the plan; full
   lazy spawn deferred):
   - The client exposes `usable` / `closed` / `failure` liveness getters.
   - On a CLIENT-TERMINAL failure (child exit, ready timeout, close — the
     client's `usable` is false) the agent's failure path — and the cold-start
     path — triggers the full idle-exit dispose (`#onIdleExit`), so the host
     unregisters the dead agent and re-resumes a FRESH client on the next
     prompt. Ordinary per-turn failures never dispose.
   - The spawn-grace reaper is now OPT-IN (`spawn({spawnGraceMs})`) and only
     the self-closing catalog-probe client arms it (env
     `HERMES_SPAWN_GRACE_MS`, default 10 min, `0` disables). AGENT-HELD
     clients never arm it: a view-time eager resume may legitimately sit
     unprompted far beyond any grace, and reaping it stamped the terminal
     "hermes gateway client closed" failure that wedged every later prompt
     (the reported wedge). Accepted trade-off until full lazy spawn lands: a
     resumed-but-never-prompted session pins its gateway child until the host
     disposes the agent (session close / owner unload).
   - Turn errors are CLASSIFIED instead of a bare UNKNOWN:
     `GatewayRpcError` 4001/4006 → `NATIVE_SESSION_GONE` (message names the
     stored gateway session), gateway child exit/error → `GATEWAY_CRASH`,
     dead client → `CLIENT_CLOSED`. The code renders in the Web UI error chip
     (`turn/end {kind:"error", error:{message, code}}`).
   - `stored_session_id` DRIFT tolerance: adoption
     (session.create/resume response) fires the client's `onAdopted` listener;
     the provider's map upsert always tracks the latest adopted pair, so a
     gateway that remints the durable key on resume cannot strand future
     resumes on a stale key.
8. **Model list / switching semantics** (unchanged, recorded): selection
   applies to the session's pinned route immediately (next request); a fresh
   session receives the model at `session.create`. The gateway resolves its
   own provider from the model id; the adapter does not second-guess it.
9. **Homes** (dev-rules §5/§13): the Hermes runtime keeps its native
   `~/.hermes` home — never redirected, never seeded. `<dshHome>/agents/hermes/`
   holds only the adapter's DSH-side state (`dsh-sessions.json`).

## Testing

```bash
npm run build
DSH_HOME=<repo>/.tests node --test test/*.test.mjs
```

All unit/fixture tests fake the gateway child (`setGatewayFactory`) — no real
python child in tests except the opt-in live suite
(`hermes-client.live.test.mjs`, skips without a live gateway).

## Trap: `npm install` materializes the hub link

This package depends on `@pgmi-builds/agent-hub` via `file:../agent-hub`. A
bare `npm install` replaces the symlink with a PHYSICAL copy → a second hub
instance in the same process → every world webServer stays `pending` forever.
After any `npm install` here, re-link it:

```bash
rm -rf node_modules/@pgmi-builds/agent-hub
ln -s ../../../../agent-worlds/agent-hub node_modules/@pgmi-builds/agent-hub
```
