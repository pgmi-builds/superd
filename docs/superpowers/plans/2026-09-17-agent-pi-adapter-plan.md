# agent-pi Adapter (AW-F) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@pgmi-builds/agent-adapter-pi` — a dsh-plugin AgentFactory that drives the pi coding agent (`@earendil-works/pi-coding-agent@0.84.2`) **in-process via its SDK**, keeping pi's **native data home `~/.pi`** (per-adapter ruling, 2026-09-17 user) while the DSH session log remains the WebUI copy (duplication accepted).

**Architecture:** Port of the agent-codex (AW-E SDK line) lifecycle — `PiProvider` (Service + AgentFactory) → `PiAgent` (Agent shim) → `PiSessionClient` (one AgentSession per session) — with the event projection taken from the shared omp/codex wire vocabulary. No sidecar, no subprocess, no bridge sqlite. Structure references agent-omp per user directive.

**Tech Stack:** TypeScript (ESM, NodeNext), `@earendil-works/pi-coding-agent 0.84.2` (exact-pin, in-process), cordis Service, dsh peer packages 0.1.5-rc.2 (vendored types), `node --test`.

**Spec:** this document §Design Rulings (the design was approved in chat 2026-09-17; codex precedent dev-rules §8/§10/§12/§13 in `apps/agent-worlds/agent-adapter-dev-rules.md`).

## Design Rulings (per-adapter, recorded)

1. **Native home `~/.pi`** — the adapter passes NO `agentDir`/home overrides to the SDK in production; `getAgentDir()` default applies (respects `PI_CODING_AGENT_DIR` for tests). Whatever the user configured for the pi CLI (auth.json, models.json, settings.json, skills, extensions, project trust) works identically. **No app-home seeding, no config one-way-valve** — dev-rules §5's `<dshHome>/agents/<runtime>` app-home ruling is **superseded for pi's runtime data** by the 2026-09-17 user directive.
2. **`<dshHome>/agents/pi/` = adapter-owned DSH state only** — currently just `dsh-sessions.json` (the mapping). pi never reads it; it is DSH-side bookkeeping in the same class as the DSH session log (user: "like omp, and path <dshhome>/agents/pi").
3. **Session duplication accepted** — pi writes its native JSONL under `~/.pi/agent/sessions/<encoded-cwd>/`; the adapter writes the DSH log through upstream `session-persistence-jsonl` (factory holds the write channel). WebUI reads the DSH copy; the native copy stays pi's authority. No back-read of pi transcripts for list/replay.
4. **Session identity = "mapping only"** (codex model): DSH session id is the authority; the pi session file path is `null` until the first prompt materializes it; resume resolves through the map and fails closed when unknown. **Lazy iron law**: zero pi objects before the first real prompt (omp §一).
5. **Runtime wiring = in-process SDK** (user 2026-09-17): `createAgentSession` runs in the dsh host process; shared module-level `ModelRuntime` singleton; `RpcClient`/subprocess is NOT used.
6. **Model route**: one provider id `pi` on `ctx.llm`; model ids are **composite `<provider>/<modelId>`** (pi is multi-provider; codex's bare id would collide). Selection is live (`session.setModel`).
7. **Permission presets → pi toolsets** (launch-only, at session creation): `danger-full-access`/`workspace-write` → pi default tools (`read,bash,edit,write`); `read-only` → `read,grep,find,ls`. pi has no runtime approval channel; `/permission` shadowed per-session (codex pattern). `PI_APPROVAL_MODE` env override selects the preset in headless runs.
8. **Compaction is WIRED** (unlike codex): `/compact` works via `session.compact()`; `compaction_start/end` events → DSH `compaction/start|end` (`{compactionId}`).
9. **Title**: pi owns titles — `session_info_changed` → `session/title` `{title, messageSeqs: [], source:{kind:"provider",provider:"pi"}}`; dsh `session-title-llm` stays disabled in the patch.

## Global Constraints

- Upstream source zero-modification; deps exact-pin; TS-`private` only (no `#` methods on Service-proxied classes — tracing proxy breaks brand checks; plain `#` fine on non-proxied classes like the client).
- DSH event vocabulary + v3 coordinates: surface events need positive `turn`/`step`; `tool/call` arguments = RAW JSON string; `assistant/message` carries `stream` records, no `sourceEventSeqs`.
- Events map to the wire vocabulary codex/omp share: `agent_start, turn_start, message_start, message_update, message_end, tool_execution_start, tool_execution_end, turn_end, agent_end` (+ pi-specific: `session_title`, `compaction_start`, `compaction_end`).
- Tests: `node --test test/*.test.mjs`, import `dist/`, build first (`npm run build` = `tsc -p tsconfig.json`); isolated homes via `mkdtempSync`; `PI_CODING_AGENT_DIR` points to a temp home in tests that touch the SDK seam.
- Port discipline: files marked **[port]** are byte-close ports of the named agent-codex file with the deltas listed; the codex file in-repo is the source of truth for everything not listed as a delta.

---

### Task 1: Package scaffold

**Files:**
- Create: `apps/agent-worlds/agent-pi/package.json`
- Create: `apps/agent-worlds/agent-pi/tsconfig.json` (copy codex verbatim)
- Create: `apps/agent-worlds/agent-pi/types/` (copy codex `types/@deepseek-ai/` tree verbatim)
- Create: `apps/agent-worlds/agent-pi/cordis.patch.yml` (codex's with `pi-provider`/`@pgmi-builds/agent-adapter-pi`)
- Create: `apps/agent-worlds/agent-pi/README.md` (Design Rulings verbatim)
- Create: `apps/agent-worlds/agent-pi/src/index.ts` (placeholder export)

**Interfaces:** Produces the package skeleton every later task compiles inside.

- [ ] Copy tsconfig + types from agent-codex; write package.json:

```json
{
  "name": "@pgmi-builds/agent-adapter-pi",
  "version": "0.0.1-aw",
  "description": "Pi provider for DeepSeek Harness (dsh) — an AgentFactory that embeds the pi coding agent in-process via the @earendil-works/pi-coding-agent SDK and bridges pi's session surface into Dash Agent/Session contracts (Agent Worlds AW-F). pi keeps its native data home ~/.pi (2026-09-17 ruling).",
  "type": "module",
  "main": "dist/index.js",
  "exports": { ".": "./dist/index.js", "./world": "./dist/world-plugin.js" },
  "scripts": { "build": "tsc -p tsconfig.json", "test": "node --test test/*.test.mjs" },
  "dependencies": {
    "@earendil-works/pi-coding-agent": "0.84.2",
    "@pgmi-builds/agent-hub": "file:../agent-hub",
    "zod": "3.25.76"
  },
  "devDependencies": { "@types/node": "^26.2.0", "typescript": "^5.6.0" },
  "peerDependencies": { "@deepseek-ai/cordis": "^4.0.1", "@deepseek-ai/dsh-agent": "0.1.5-rc.2", "@deepseek-ai/dsh-agent-presets": "0.1.5-rc.2", "@deepseek-ai/dsh-llm": "0.1.5-rc.2", "@deepseek-ai/dsh-scope": "0.1.5-rc.2", "@deepseek-ai/dsh-session": "0.1.5-rc.2", "@deepseek-ai/dsh-session-persistence": "0.1.5-rc.2", "@deepseek-ai/dsh-typert-protocol": "0.1.5-rc.2" },
  "peerDependenciesMeta": { "@deepseek-ai/cordis": { "optional": true }, "@deepseek-ai/dsh-agent": { "optional": true }, "@deepseek-ai/dsh-agent-presets": { "optional": true }, "@deepseek-ai/dsh-llm": { "optional": true }, "@deepseek-ai/dsh-scope": { "optional": true }, "@deepseek-ai/dsh-session": { "optional": true }, "@deepseek-ai/dsh-session-persistence": { "optional": true }, "@deepseek-ai/dsh-typert-protocol": { "optional": true } },
  "files": ["dist", "cordis.patch.yml", "README.md"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "private": true,
  "license": "MIT",
  "engines": { "node": ">=22.18" }
}
```

- [ ] `cd apps/agent-worlds/agent-pi && npm install --ignore-scripts --cache ../../../.npm-cache` (installs pi SDK nested); then symlink the `@deepseek-ai/*` peer set + `@pgmi-builds/agent-hub` into `node_modules/` exactly as agent-codex has them (`ls -la ../agent-codex/node_modules/@deepseek-ai/` is the reference).
- [ ] `npm run build` green with a one-line `src/index.ts` placeholder; commit.

### Task 2: Home resolution + knobs (TDD)

**Files:** Create `src/pi-home.ts`, `src/knobs.ts`; Test `test/pi-home.test.mjs`

**Interfaces (Produced):**
- `resolvePiStateDir(home?: string): string` — `<dshHomePath>/agents/pi` (adapter state; prod-guarded)
- `piMappingPath(home?: string): string` — `<stateDir>/dsh-sessions.json`
- `PI_TRACE`, `PI_IDLE_EXIT_MS` (knobs)

**Deltas vs codex-store.ts:** NO `.codex`-style nesting, NO `ensureCodexAppHome` analog, NO env override of the pi home (the SDK reads `PI_CODING_AGENT_DIR` itself — the adapter never redirects it). Prod guard kept (`~/.dsh`, `~/.superd`).

- [ ] RED: temp-home test asserts `resolvePiStateDir(home) === join(home, "agents", "pi")`, mapping path join, prod-home throws.
- [ ] GREEN: implement (mkdir only happens in session-map writes, not here).
- [ ] Commit `feat(agent-pi): home/state-dir resolution (native ~/.pi ruling)`.

### Task 3: session-map (TDD) — **[port]** codex `session-map.ts`

**Files:** Create `src/session-map.ts`; Test `test/session-map.test.mjs` (port codex test, s/.codex/agents\/pi/)

**Deltas:** `PiSessionRecord { sessionFile: string | null; cwd: string; createdAt: number; preset: string | null }` (sessionFile replaces threadId).

- [ ] RED (port codex tests: round-trip, merge-on-observe, malformed fail-soft, forget) → GREEN (port module) → commit.

### Task 4: pi-events projection (TDD)

**Files:** Create `src/pi-events.ts`; Test `test/pi-events.test.mjs`

**Interfaces (Produced):** `projectSessionEvent(raw: unknown): WireEvent | WireEvent[] | null`; wire types:

```ts
export type WireContentBlock = { type: "text"; text: string } | { type: "thinking"; thinking: string } | { type: "toolCall"; id: string; name: string; arguments: string };
export type WireMessage = { role: "user" | "assistant" | "toolResult"; content: WireContentBlock[]; provider?: string; model?: string; usage?: Record<string, number>; stopReason?: string; errorMessage?: string; errorStatus?: number; toolCallId?: string; isError?: boolean };
export type WireEvent =
  | { type: "agent_start" } | { type: "agent_end" } | { type: "agent_settled" }
  | { type: "turn_start" } | { type: "turn_end" }
  | { type: "message_start"; message: WireMessage } | { type: "message_end"; message: WireMessage }
  | { type: "message_update"; assistantMessageEvent: { type: string; delta?: string; contentIndex?: number } }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: { content?: WireContentBlock[] }; isError: boolean }
  | { type: "session_title"; name: string | undefined }
  | { type: "compaction_start"; reason: string } | { type: "compaction_end"; aborted: boolean };
```

Mapping (pure, duck-typed on pi's event shapes — verified against pi-agent-core dist): pi `message.content` blocks text/thinking/toolCall → same-named wire blocks (toolCall args stringified); `session_info_changed`→`session_title`; `compaction_start/end`→same names; `queue_update`/`entry_appended`/`auto_retry_*`/`thinking_level_changed` → `null` (unmapped). Unknown types → `null` (never throw).

- [ ] RED: table-driven tests over synthesized pi events → GREEN → commit.

### Task 5: models — ModelRuntime seam + catalog memo (TDD)

**Files:** Create `src/models.ts`; Test `test/models.test.mjs`

**Interfaces (Produced):**
- `getPiModelRuntime(): Promise<PiModelRuntimeLike>` — module singleton; `setPiModelRuntimeFactory(factory)` test seam
- `warmPiCatalog(): Promise<void>` — fills the memo via `runtime.getAvailable()`
- `readPiModelCatalog(): { provider: "pi"; providerName: string; models: {id; label; context?}[]; defaultModel: string | undefined }` — **synchronous** memo read; empty models → `PI_DEFAULT_MODEL_PLACEHOLDER = "pi-default"` semantics like codex
- `PI_PROVIDER_ID = "pi"`; default model = `settings.json` (`defaultProvider`/`defaultModel` via `join(getAgentDir(), "settings.json")`, sync fail-soft read) → composite `${defaultProvider}/${defaultModel}`

Composite id rule: `catalogId(model) = `${model.provider}/${model.id}``; `splitCatalogId(id)` → `{provider, modelId}` (first `/`).

- [ ] RED: fake runtime returns 2 models + temp `PI_CODING_AGENT_DIR` settings.json → warm → sync catalog sees both + default; unreadable → placeholder; GREEN; commit.

### Task 6: LlmAdapter (TDD) — **[port]** codex `adapter.ts`

**Files:** Create `src/adapter.ts`; Test `test/adapter.test.mjs`

**Deltas:** `PiLlmAdapter` (no home arg — reads the memo); `listModels`/`resolveModel` over composite ids; `resolveModel` includes `context: { contextWindow }` when the memo entry has it; `stream` throws `UNSUPPORTED_STREAM` (same).

- [ ] RED/GREEN/commit.

### Task 7: pi-client (TDD)

**Files:** Create `src/pi-client.ts`; Test `test/pi-client.test.mjs`

**Interfaces (Produced):** `class PiSessionClient` mirroring the codex client surface (`spawn`, `on`, `onFailure`, `getState`, `prompt`, `followUp`, `steer`, `setModel`, `setThinkingLevel`, `compact`, `abort`, `ensureStarted`, `spawned`, `close`, `sessionFile` getter) + seams `setPiSessionFactory`.

Key semantics (deltas vs codex client):
- **Lazy**: `spawn(args, cwd, mode)` constructs a zero-IO shell (`mode: {kind:"create"; tools?: string[]} | {kind:"resume"; sessionFile: string}`); `ensureStarted()` runs the real `factory({cwd, mode})` once (default factory: `ModelRuntime` singleton + `createAgentSession({ modelRuntime, sessionManager: mode.kind === "resume" ? SessionManager.open(sessionFile) : SessionManager.create(cwd), cwd, ...(tools ? {tools} : {}) })`).
- Events: after start, `session.subscribe` → `projectSessionEvent` → listeners (same listener contract as codex). pi emits its own `agent_end`; the client does NOT synthesize one.
- `prompt(text)` = fire-and-forget `session.prompt(text).catch(fail)` (pi's prompt resolves only after the run — never await it in the pump).
- `steer`/`followUp` map 1:1 (pi has real steer — record in README as an upgrade over codex).
- `setModel(compositeId)` → resolve via `modelRuntime.getModel(provider, modelId)` → `session.setModel(model)`; fail-loud unknown model (fail-soft log + no-op to keep the agent loop alive — mirror codex `setModel` catch semantics).
- `compact(instructions?)` → `session.compact(instructions)` (fire-and-forget with catch).
- `close()` → `session.dispose()`.
- `sessionFile` getter → `session?.sessionFile ?? null` (null until started).

- [ ] RED with an injected fake session (subscribe/prompt/setModel recording): lazy zero-IO until ensureStarted; events pump through projection; close idempotent; failure path via rejected prompt. GREEN; commit.

### Task 8: permission mapping (TDD) — **[port]** codex `permission.ts`

**Files:** Create `src/permission.ts`; Test `test/permission.test.mjs`

**Deltas:** preset→pi **toolset** mapping (ruling 7): `danger-full-access|workspace-write → undefined` (pi defaults), `read-only → ["read","grep","find","ls"]`; `piToolset(preset)` replaces `codexApprovalMode`; env override `PI_APPROVAL_MODE` selects a preset NAME (`envApprovalMode()`); `defaultPermissionPreset`, `presetFromEvents`, `permissionEventsFor`, the `SessionEventMap` declaration merge — all ported verbatim.

- [ ] RED/GREEN/commit.

### Task 9: PiAgent (TDD) — **[port]** codex `agent.ts` + `inbox.ts`

**Files:** Create `src/agent.ts`, `src/inbox.ts` (verbatim port); Test `test/agent-bridge.test.mjs`

**Deltas (each covered by a test):**
1. usage rides the SAME `message_end(assistant)` (`message.usage` → `convertUsage` camelCase: `input/output/cacheRead/cacheWrite/reasoning` → `inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens/reasoningTokens`) — no `#pendingUsage` lag machinery.
2. `session_title` wire event → `session.append("session/title", { title, messageSeqs: [], source: { kind: "provider", provider: "pi" } })` (deduped by last title, fail-soft).
3. `compaction_start` → `session.append("compaction/start", { compactionId })`; `compaction_end` → `compaction/end` (same id; `aborted` → log-only, reason unchanged). `compactionId` = `crypto.randomUUID()`, held between the pair.
4. `/compact` registered on the agent scope → `client.compact()` (WORKS, unlike codex's refusal); `/permission` shadowed with the codex refusal text (adapted wording: approval policy is a launch-only toolset).
5. `whenIdle()` quiescence uses `client.getState().isStreaming` (same shape as codex) — no subagent check (pi has none; drop the `getSubagents` call).
6. `systemPrompt()` runtimeInfo = `client.systemPrompt()` (started ? `session.systemPrompt` : undefined); route metadata from `readPiModelCatalog()` composite entries.

Everything else — turn/step synthesis, stream bridge, remote queue, idle exit, inject narration drop, failure taxonomy `wireFailure`, `convertContent` — ports verbatim (it is already wire-vocabulary-generic).

- [ ] RED per delta (fake client emitting recorded event scripts; assert DSH log events) → GREEN → commit.

### Task 10: Provider create/resume + roster + projection (TDD) — **[port]** codex `index.ts`, `agent-preset-codex.ts`, `agent-preset-projection.ts`

**Files:** Create `src/index.ts`, `src/agent-preset-pi.ts`, `src/agent-preset-projection.ts`; Test `test/provider-resume.test.mjs`, `test/agent-preset-roster.test.mjs`

**Deltas vs codex index.ts:**
- `PiProvider extends Service implements AgentFactory`; `static inject = ["agents","sessions","llm","agentDefaultModel","settings"]` (same boot-order trap — keep the comment).
- `#resolveHome()` same; `this.stateDir = resolvePiStateDir(this.home)`; NO app-home seeding. `PI_TRACE=1` trace helper.
- `#registerModelCatalog()`: `llm.registerAdapter([PI_PROVIDER_ID], new PiLlmAdapter())` + `void warmPiCatalog().then(#registerDefaultModel-push)` (echo-guarded `defaultModelKey`, `settings.replace("agent-default-model", {provider:"pi", model})` — codex `#registerDefaultModel` verbatim modulo source).
- `createAgent()`: fork refusal (pi has no fork) verbatim; `requirePersistence`; preset = `envApprovalMode() ?? defaultPermissionPreset(loopCtx)`; `toolset = piToolset(preset)`; client = `PiSessionClient.spawn([], spawnCwd, { kind: "create", ...(toolset ? { tools: toolset } : {}) })` (zero-IO); `upsertSession(this.stateDir, id, { sessionFile: null, cwd, createdAt, preset })`; `followSessionFile(id, client)` (once `sessionFile` non-null → `upsertSession` merge; arrow FIELD, fail-soft log); `setupAndPublish(...)` module-level port.
- `resume()`: record lookup fail-closed verbatim ("no pi session is recorded…" / "never started (no session file recorded)"); `validatedCwd(record.cwd)`; persistence open → closers → prepare (verbatim); client resume mode `{kind:"resume", sessionFile: record.sessionFile}`.
- `sessionAgentOptions()`: provider `pi`; explicit composite model wins; else catalog default unless placeholder.
- Roster: `SinglePiPresetRoster` (id `"pi"`, name `"Pi"`) on the top-level fiber; `piAgentPresetProjection` (init `"pi"`).

- [ ] RED: resume fail-closed paths (missing record / null sessionFile / dead cwd); create writes map with null sessionFile; roster list/resolve 404 shape; projection fold. GREEN; full `npm test` + `tsc` 0; commit.

### Task 11: world plugin + patch + README finalize

**Files:** Create `src/world-plugin.ts` (**[port]** codex verbatim, `KEY='pi'`, `name='aw.agent-adapter-pi'`); finalize `cordis.patch.yml`; README completion.

- [ ] Patch rows: insert `pi-provider`; disable `agent-loop`, `llm-deepseek`, `llm-pi-ai`, `agent-presets`; keep `session-persistence-jsonl` mounted; permission 3-preset table (`defaultPreset: danger-full-access`); directory-picker browse pin (verbatim from codex — the §4.1 trap).
- [ ] Build + all tests green; single-instance check `find node_modules/@deepseek-ai -maxdepth 1 -mindepth 1 ! -type l`; commit.

### Task 12: Form-A standalone acceptance (user-gated)

- [ ] Port `test/verify-codex-app.mjs` → `test/verify-pi-app.mjs`; own test home `.superd-test` profile per line conventions; 4999 discipline (`ss` pre-check, `systemd-run --user`, token from log watermark).
- [ ] Wire acceptance: auth → `session/create` → real pi turn (real model via `~/.pi` auth) → `session/page` readback (`turn/start, user/message, tool/*, assistant/message` incl. stream chunks, `turn/end`) → restart → `session/list` + resume → second turn continues context → `~/.pi/agent/sessions/<encoded-cwd>/` shows pi's native copy (duplication proven).
- [ ] Lazy checks: browsing/replay spawns zero SDK work; first prompt materializes exactly one session file.
- [ ] Report + leave instance running for the user's hands-on pass (验收模式：起服务器就停手，等用户测完).

### Task 13: Form-B world registration

- [ ] Register the `pi` world in the line's bootstrap/start script set (mirror how `codex`/`omp` worlds are provisioned; `./world` export + `@pgmi-builds/agent-hub` link already in place).
- [ ] Hub roster shows `pi` alongside codex/omp; spawn + delegate one turn through the hub.

---

## Self-Review

- Spec coverage: rulings 1–9 → Tasks 2 (1,2), 3 (2,4), 7+9 (4), 1+11 (3,5), 5+6 (6), 8 (7), 9 (8,9). ✔
- Placeholders: none — ports cite exact in-repo source files; deltas carry code.
- Type consistency: `sessionFile` (not threadId) throughout; composite model ids produced in Task 5, consumed in 6/7/10. ✔
