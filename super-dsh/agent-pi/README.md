# @pgmi-builds/agent-adapter-pi (Agent Worlds AW-F)

pi coding agent provider for DeepSeek Harness — an `AgentFactory` dsh plugin that embeds the
**pi coding agent** (`@earendil-works/pi-coding-agent@0.84.2`) **in-process via its SDK**
(`createAgentSession` / `AgentSession` / `ModelRuntime`) and bridges pi's session surface into
the Dash Agent/Session contracts. Structure follows `agent-omp` (same pi-agent-core lineage);
lifecycle follows `agent-codex` (AW-E SDK line, DSH-native session persistence).

## Per-adapter rulings (2026-09-17 user; decisions recorded per dev-rules §4/§12)

1. **Native data home `~/.pi`.** Unlike every prior adapter (codex `<dshHome>/agents/codex`,
   omp `<dshHome>/agents/omp/.omp`), pi keeps its **native home**: the adapter passes no
   `agentDir` override, so the SDK's `getAgentDir()` default applies — auth, models, settings,
   skills, extensions and project trust are exactly what the user's pi CLI sees. No app-home
   seeding, no config one-way-valve. Dev-rules §5/§13's app-home ruling is superseded for pi's
   runtime data by this directive. Tests redirect via `PI_CODING_AGENT_DIR` /
   `PI_CODING_AGENT_SESSION_DIR` env only.
2. **`<dshHome>/agents/pi/` = adapter-owned DSH state only** — currently the mapping file
   `dsh-sessions.json`. pi never reads it; it is DSH-side bookkeeping in the same class as the
   DSH session log itself.
3. **Session storage duplication accepted**: pi writes its native session JSONL under
   `~/.pi/agent/sessions/<encoded-cwd>/`; the adapter writes the DSH log through upstream
   `session-persistence-jsonl` (factory holds the write channel). The WebUI reads the DSH copy;
   the native copy stays pi's authority; no back-read of pi transcripts for list/replay.
4. **Session identity = "mapping only"** (codex model): the DSH session id is the authority;
   the pi session file path is `null` in the map until the first prompt materializes it; resume
   resolves through the map and **fails closed** when unknown. Lazy iron law: zero pi objects
   before the first real prompt.
5. **In-process SDK** (user choice "sdk, refer to omp agent adapter"): no sidecar, no
   `--mode rpc` subprocess. Shared module-level `ModelRuntime`; one `AgentSession` per session.
6. **Model route**: single provider id `pi` on `ctx.llm`; model ids are composite
   `<provider>/<modelId>` (pi is multi-provider). Selection is live (`session.setModel`) — an
   upgrade over the codex SDK line's next-turn-only switch. `steer` is also real (pi supports it).
7. **Permission presets → launch-only toolsets** (pi has no per-action approval):
   `danger-full-access` / `workspace-write` → pi default tools (`read,bash,edit,write`);
   `read-only` → `read,grep,find,ls`. `/permission` is shadowed per-session with a clean
   refusal; `PI_APPROVAL_MODE=<preset-name>` overrides for headless runs.
8. **Compaction is wired** (unlike codex): `/compact` works via `session.compact()`;
   pi `compaction_start|end` → DSH `compaction/start|end` with a generated `compactionId`.
9. **Titles**: pi owns them — `session_info_changed` → DSH `session/title`
   (`source: {kind:"provider", provider:"pi"}`); the dsh `session-title-llm` row stays disabled.

## Layout

`src/`: `index.ts` (PiProvider + `setupAndPublish` transaction), `agent.ts` (PiAgent shim),
`pi-client.ts` (SDK client seam + lazy start), `pi-events.ts` (pi → wire vocabulary projection),
`session-map.ts`, `models.ts` (ModelRuntime singleton + catalog memo), `adapter.ts` (LlmAdapter),
`permission.ts`, `agent-preset-pi.ts` + `agent-preset-projection.ts` (roster/chip), `pi-home.ts`
(state dir), `knobs.ts`, `inbox.ts`, `world-plugin.ts` (hub bridge).

## Testing

`npm run build` then `node --test test/*.test.mjs` — tests import `dist/`, use temp homes, and
inject fake pi sessions via `setPiSessionFactory`; the SDK seam is never hit by unit tests.
Acceptance = standalone `dsh + adapter` real instance (form A) with a real pi turn, then the
world form (form B) via the hub.

## Trap: `npm install` materializes the hub link

`dependencies["file:../agent-hub"]` gets materialized by `npm install` as a
**physical copy** under `node_modules/@pgmi-builds/agent-hub` — a second hub
module instance whose rosters/mount-registry are dead. Symptom in world form:
the world's virtual webServer never appears (`9 entries did not activate`,
everything pending on webServer). After ANY `npm install` in this package,
re-link: `rm -rf node_modules/@pgmi-builds/agent-hub && ln -sfn ../../../agent-hub
node_modules/@pgmi-builds/agent-hub` (codex symlink discipline; same class as
the `@deepseek-ai/*` heal).
