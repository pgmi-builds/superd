/**
 * agent-pi provider — Pi provider plugin for DeepSeek Harness
 * (Agent Worlds AW-F, SDK line).
 *
 * Replaces the built-in agent loop with an `AgentFactory` that drives pi
 * `AgentSession`s in-process (one `PiSessionClient` per session, through the
 * `@earendil-works/pi-coding-agent` SDK) and bridges the projected wire
 * stream into the Dash Agent/Session contracts. Mirrors
 * `@deepseek-ai/dsh-agent-loop`'s creation transaction (prepare → owned
 * storage handle → setup → publish) so the session + agent publish as one
 * ordered lifecycle AND the DSH session log is written through the upstream
 * `sessionPersistence` service — list/read/replay/workspace grouping are then
 * ordinary DSH services over that log.
 *
 * Session identity ("mapping only", codex model): the DSH session id is the
 * authority — supplied by the harness at create (`options.sessionId`) and
 * resume (`options.resumeSessionId`). pi's session file only materializes at
 * the first prompt, so the pairing is persisted in the adapter's DSH-side
 * state dir (`<dshHome>/agents/pi/dsh-sessions.json`, see session-map.ts).
 * Resume resolves that record and fails closed when the session is unknown.
 *
 * HOME RULING (2026-09-17 user): pi's runtime home is the NATIVE `~/.pi` —
 * this adapter never redirects `PI_CODING_AGENT_DIR`, seeds no app home, and
 * copies no config (the user's pi CLI state IS our state). Session storage is
 * duplicated by design: pi's native JSONL stays pi's authority; the DSH log
 * is the WebUI copy.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { Context, Service } from "@deepseek-ai/cordis";
import type {
  Agent,
  AgentFactory,
  AgentHandle,
  AgentOptions,
  AgentSetup,
  CreateAgentOptions,
  ResumeAgentOptions,
} from "@deepseek-ai/dsh-agent";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import type { AdapterRegistrationHandle, LlmRuntime } from "@deepseek-ai/dsh-llm";
import {
  SessionLogOffset,
  SessionPreparation,
  interruptedTurnClosers,
  type Session,
  type SessionEvent,
  type SessionId,
} from "@deepseek-ai/dsh-session";
import type { SessionHandle, SessionPersistence } from "@deepseek-ai/dsh-session-persistence";
import { PiSessionClient } from "./pi-client.js";
import { PiAgent, type PiAgentRuntimeInfo } from "./agent.js";
import { PiLlmAdapter } from "./adapter.js";
import { SinglePiPresetRoster } from "./agent-preset-pi.js";
import { piAgentPresetProjection } from "./agent-preset-projection.js";
import { resolvePiStateDir } from "./pi-home.js";
import { sessionRecord, upsertSession } from "./session-map.js";
import { warmPiCatalog, readPiModelCatalog, piProviderIds, resolvePiSelection, PI_PROVIDER_ID } from "./models.js";
import { defaultPermissionPreset, envApprovalMode, piToolset, presetFromEvents } from "./permission.js";
import { trace } from "./knobs.js";

/** Realpath of a recorded cwd, accepted only when it names an existing directory. */
function validatedCwd(cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined;
  try {
    const canonical = realpathSync(cwd);
    return statSync(canonical).isDirectory() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

/** An owned write handle plus the count of events already stored through it. */
interface StoredSession {
  readonly handle: SessionHandle;
  storedCount: number;
}

/** Open a read handle, pull the complete stored log, close. */
async function readStoredEvents(
  persistence: SessionPersistence,
  id: SessionId,
  signal?: AbortSignal,
): Promise<readonly SessionEvent[]> {
  const handle = await persistence.open(id, "read", signal === undefined ? {} : { signal });
  try {
    return (await handle.read(0, undefined, signal === undefined ? {} : { signal })).events;
  } finally {
    await handle.close();
  }
}

/** Whether the stored log carries real conversation content (any turn,
 *  user-authored message, or assistant message) — the orphan discriminator for
 *  blank-tolerant resume (2026-09-18: blank = resumable-as-fresh; content
 *  without a pairing = genuine unknown, fail loud). */
function hasConversationContent(events: readonly SessionEvent[]): boolean {
  return events.some((event) => {
    if (event.type === "turn/start" || event.type === "assistant/message") return true;
    if (event.type === "user/message") {
      const data = event.data as { source?: { kind?: unknown } } | undefined;
      return data?.source?.kind === "user";
    }
    return false;
  });
}


export class PiProvider extends Service implements AgentFactory {
  /**
   * `agentDefaultModel` and `settings` are load-bearing, not decorative (omp
   * / codex twin, same boot-order trap): the harness owns the "default for
   * new sessions" selection there, and this bridge is the only thing that
   * feeds it pi's settings.json default. Without the inject the context
   * cannot resolve the service at apply time and the push never fires — the
   * picker keeps advertising a model no adapter in this world serves.
   */
  static inject: string[] = ["agents", "sessions", "llm", "agentDefaultModel", "settings"];

  /** Plain holder — prevents Cordis re-tracing the factory's ctx through a caller shadow. */
  private readonly runtime: { ctx: Context };
  /**
   * The DSH home (captured once from the world's own `dshHomePath` — never
   * ambient env inside plugins) and the adapter's DSH-side state dir derived
   * from it: `<home>/agents/pi`. NOT pi's runtime home — pi keeps its native
   * `~/.pi` (2026-09-17 ruling).
   */
  private readonly home: string;
  private readonly stateDir: string;
  /** Echo/staleness guard for the app-wide default-model push. */
  private defaultModelKey = "";

  constructor(ctx: Context) {
    super(ctx, "piProvider");
    this.runtime = { ctx };
    this.home = this.#resolveHome();
    this.stateDir = resolvePiStateDir(this.home);
    trace(`home: dshHome=${this.home} stateDir=${this.stateDir} (pi runtime home = native ~/.pi)`);
    ctx.effect(() => ctx.agents.setFactory(this), "piProvider.setFactory()");
    this.#registerModelCatalog();
    // The roster must be visible to the API gateway's root-level remote
    // enumeration (dsh-host-apiproxy read it from the root service table);
    // nesting it under a child fiber via ctx.plugin hides its @Remote routes
    // from the gateway and every agentPresets/* call 404s. Register it on
    // this plugin's own (top-level) fiber instead.
    new SinglePiPresetRoster(ctx);
    // Drive the `agentPreset` session projection ourselves: the upstream
    // registrant lives in the (disabled) dsh-agent-presets package, but the
    // Web UI gates the preset chip and header label on
    // `projectionValues.agentPreset`.
    ctx.inject(["sessionProjections"], (scoped: Context) => {
      scoped.sessionProjections.register(piAgentPresetProjection);
    });
  }

  /**
   * The factory owns its sessions' route (codex directive parity): a session
   * created by this factory always runs on a pi-served route, with pi's
   * settings default model unless the caller asked for a served model. The
   * requested selection resolves through the catalog — a real slug pair
   * (picker route) or a legacy composite under the umbrella `pi` route — and
   * rides the session only when the catalog actually serves it; an
   * unresolved choice is omitted so pi's own default applies (placeholder
   * values never flow into options).
   */
  private sessionAgentOptions(requested: AgentOptions | undefined): AgentOptions {
    const resolved = resolvePiSelection(requested?.provider, requested?.model) ?? readPiModelCatalog().defaultSelection;
    return {
      ...(requested ?? {}),
      provider: resolved?.provider ?? PI_PROVIDER_ID,
      ...(resolved === undefined ? {} : { model: resolved.model }),
    };
  }

  /**
   * The write path is mandatory: this factory owns the DSH session log
   * through the upstream persistence service — a session created or resumed
   * without a backend would persist nothing.
   */
  private requirePersistence(op: "create" | "resume"): SessionPersistence {
    const persistence = this.runtime.ctx.get("sessionPersistence") as SessionPersistence | undefined;
    if (persistence === undefined) {
      throw new Error(`cannot ${op} a pi session: session persistence is not configured`);
    }
    return persistence;
  }

  /**
   * Take a fresh session's write ownership. Nothing is appended here: the
   * constructor seed (which never re-emits through `session/event`) is stored
   * by `appendUnstoredSuffix` at the publication commit point, so a failed or
   * cancelled setup closes an unmaterialized handle and leaves no residue.
   */
  private async createStoredSession(
    persistence: SessionPersistence,
    session: Session,
    signal?: AbortSignal,
  ): Promise<StoredSession> {
    const handle = await persistence.create(session.header, {
      inheritedEventCount: session.inheritedEventCount,
      ...(signal === undefined ? {} : { signal }),
    });
    return { handle, storedCount: 0 };
  }

  /**
   * Runtime facts the agent stamps into the log: pi's own system prompt
   * (live on the SDK session once started) and the effective route metadata
   * (the selected model's real provider slug + bare id, else the catalog
   * default, plus the model's context window).
   */
  private agentRuntime(client: PiSessionClient): PiAgentRuntimeInfo {
    return {
      systemPrompt: (): string | undefined => client.systemPrompt(),
      routeContext: (preferred: { provider?: string; model?: string } | undefined) => {
        const catalog = readPiModelCatalog();
        const resolved = resolvePiSelection(preferred?.provider, preferred?.model) ?? catalog.defaultSelection;
        if (resolved === undefined) return undefined;
        const entry = catalog.models.find((candidate) => candidate.provider === resolved.provider && candidate.id === resolved.model);
        return {
          provider: resolved.provider,
          model: resolved.model,
          ...(entry?.contextWindow !== undefined && entry.contextWindow > 0 ? { contextWindow: entry.contextWindow } : {}),
        };
      },
    };
  }

  /** $DSH_HOME as the input: boot-provided home first, env last. */
  #resolveHome(): string {
    const fromBoot = this.runtime.ctx.get("dshHomePath");
    if (typeof fromBoot === "string" && fromBoot !== "") return fromBoot;
    if (typeof fromBoot === "function") {
      const resolved = (fromBoot as () => string)();
      if (typeof resolved === "string" && resolved !== "") return resolved;
    }
    return process.env.DSH_HOME ?? join(process.cwd(), ".tests", "aw");
  }

  /**
   * App-wide wiring the adapter owns: register the adapter on a boot
   * placeholder route, warm the model catalog once, swap the registration
   * to the real per-provider slug routes (omp parity — the picker groups by
   * real provider), then push pi's settings.json default into the world's
   * `agentDefaultModel` (codex `#registerDefaultModel` verbatim modulo the
   * source). One-directional on purpose — pi's settings are read-only for
   * us.
   */
  #registerModelCatalog(): void {
    const llm = this.runtime.ctx.get("llm") as LlmRuntime | undefined;
    if (llm === undefined) return;
    // registerAdapter must not be empty and the selector must never see a
    // routeless window: boot under the placeholder `pi` route, then swap
    // atomically to the real slugs once the catalog is warm.
    const handle = llm.registerAdapter([PI_PROVIDER_ID], new PiLlmAdapter());
    void warmPiCatalog()
      .then(() => {
        this.#replaceRoutes(handle);
        this.#pushDefaultModel();
      })
      .catch((error) => {
        trace(`catalog warm failed (selector serves nothing until retry): ${String(error)}`);
      });
  }

  /**
   * Swap the boot placeholder route for the real per-provider slug routes.
   * Atomic (`handle.replace`): no request observes a gap, and a failure
   * keeps the placeholder — which serves nothing from a cold memo and is
   * logged, never fatal (fail-soft with a trace).
   */
  #replaceRoutes(handle: AdapterRegistrationHandle): void {
    const slugs = piProviderIds();
    try {
      handle.replace(slugs);
      trace(`provider routes: ${slugs.length === 0 ? "(empty catalog — zero routes)" : slugs.join(", ")}`);
    } catch (error) {
      this.runtime.ctx.logger.warn(`pi-provider: provider-route swap failed (placeholder stays): ${String(error)}`);
    }
  }

  #pushDefaultModel(): void {
    this.runtime.ctx.inject(["agentDefaultModel", "settings"], (mCtx) => {
      const service = mCtx.get("agentDefaultModel") as
        | {
          currentSelection?: () => { provider: string; model: string };
          saveSelection?: (selection: { provider: string; model: string }) => Promise<unknown>;
        }
        | undefined;
      if (service === undefined) return;
      const target = readPiModelCatalog().defaultSelection;
      if (target === undefined) {
        trace("default model push skipped: catalog cold or pi has no default");
        return;
      }
      const targetKey = `${target.provider}/${target.model}`;
      const current = service.currentSelection?.();
      const currentKey = current === undefined ? undefined : `${current.provider}/${current.model}`;
      if (currentKey === targetKey || currentKey === this.defaultModelKey) return;
      trace(`default model: ${currentKey ?? "none"} → ${targetKey}`);
      const settings = mCtx.get("settings") as
        | { replace?: (namespace: string, value: unknown) => Promise<unknown> }
        | undefined;
      trace(`default model write: settings=${settings === undefined ? "MISSING" : typeof settings.replace}; current=${JSON.stringify(current)}`);
      void Promise.resolve((async () => {
        if (settings?.replace === undefined) throw new Error("settings.replace is unavailable on the injected context");
        // Lock-timeout is TRANSIENT (live-found 2026-09-18: a killed boot can
        // leave a stale settings.yaml.lock and every later write times out —
        // retry per the bounded-retry ruling before giving up with a trace).
        for (let attempt = 1; ; attempt++) {
          try {
            await settings.replace("agent-default-model", target);
            break;
          } catch (error) {
            if (attempt >= 3 || !/writer lock/.test(String(error))) throw error;
            trace(`default model: writer-lock timeout (attempt ${attempt}/3) — retrying in 2s`);
            await new Promise((r) => setTimeout(r, 2000));
          }
        }
        trace("default model: settings.replace resolved");
        await service.saveSelection?.(target);
        trace("default model: saveSelection resolved");
      })())
        .then(() => {
          this.defaultModelKey = targetKey;
          this.runtime.ctx.logger.info(`pi-provider: default model ← pi settings: ${targetKey}`);
        })
        .catch((error) => {
          trace(`default model WRITE FAILED: ${String(error)}`);
          this.runtime.ctx.logger.warn(`pi-provider: default model save failed: ${String(error)}`);
        });
    });
  }

  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    const loopCtx = this.runtime.ctx;
    const id = options.sessionId;
    const meta = options.meta ?? {};
    const cwd = meta.cwd;

    // Fork seeds a copied-turn prefix but pi has no native fork: fail the
    // fork cleanly at the factory boundary. `parentSession` in create
    // metadata is set only by the fork path (subagents go through
    // `ctx.subagents` instead).
    if (meta.parentSession !== undefined) {
      throw new Error(
        `cannot fork session "${meta.parentSession}" onto the Pi provider: pi has no native session fork`,
      );
    }

    const persistence = this.requirePersistence("create");

    // The toolset is pinned at session creation and the Dash session does
    // not exist yet at this point, so the effective preset cannot come from
    // session events: the env override (PI_APPROVAL_MODE, headless runs)
    // wins, else the permission service's default.
    const preset = envApprovalMode() ?? defaultPermissionPreset(loopCtx);
    const toolset = piToolset(preset);
    const spawnCwd = validatedCwd(cwd) ?? process.cwd();
    trace(`create id=${id} preset=${preset ?? "none"} tools=${toolset === undefined ? "default" : toolset.join(",")} spawnCwd=${spawnCwd}${envApprovalMode() === undefined ? "" : " (env override)"}`);

    // Backend takes ZERO part in the UI's browser-local new-session draft
    // beyond the (zero-IO) client shell: no pi session, no session events —
    // the session announces blank. pi materializes on the first prompt.
    const client = await PiSessionClient.spawn([], spawnCwd, {
      kind: "create",
      ...(toolset === undefined ? {} : { tools: toolset }),
    });

    const preparation = SessionPreparation.create(loopCtx.sessions.prepare(id, {
      ...(options.seed === undefined ? {} : { seed: options.seed }),
      ...(meta === undefined ? {} : { meta }),
      ...(options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount }),
    }));
    let stored: StoredSession | undefined;
    let handedOff = false;
    try {
      stored = await this.createStoredSession(persistence, preparation.session, options.signal);
      // Identity record BEFORE publication: the DSH id → pi session file
      // pairing (sessionFile null until the first prompt) is what resume
      // resolves.
      upsertSession(this.home, String(id), {
        sessionFile: null,
        cwd: spawnCwd,
        createdAt: Date.now(),
        preset: preset ?? null,
      });
      this.followSessionFile(id, client);
      handedOff = true;
      return await setupAndPublish(
        loopCtx,
        ownerCtx,
        id,
        this.sessionAgentOptions(options.agentOptions),
        options.setup,
        preparation.session,
        client,
        options.parentAgent,
        "startup",
        { enterSession: true, preparation },
        stored,
        this.agentRuntime(client),
      );
    } catch (error) {
      trace(`create ${id} THREW: ${String(error)}`);
      client.close();
      if (!handedOff) await stored?.handle.close().catch(() => { });
      throw error;
    } finally {
      if (!handedOff) preparation[Symbol.dispose]();
    }
  }

  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    const loopCtx = this.runtime.ctx;
    const id = options.resumeSessionId;

    // Identity ("mapping only") with BLANK-SESSION TOLERANCE (2026-09-18,
    // dev-rules §14 i / omp-web doctrine): a session whose pi side never
    // materialized (no record, or `sessionFile: null`) resumes AS FRESH —
    // the lazy shell waits for the first prompt, exactly like create (the
    // Dash host eagerly resumes on view/model-change, so failing here broke
    // every blank new session's composer AND permission selector). A MISSING
    // record stays intolerable when the DSH log carries conversation
    // content — that orphan is a genuine unknown and fails loud.
    const record = sessionRecord(this.home, String(id));
    const blank = record === undefined || record.sessionFile === null;
    trace(`resume id=${id} record=${record === undefined ? "MISSING" : record.sessionFile ?? "NO-FILE"}${blank ? " (blank-tolerant)" : ""}`);

    const persistence = this.requirePersistence("resume");

    let orphanCheck: readonly SessionEvent[] | undefined;
    if (record === undefined) {
      orphanCheck = await readStoredEvents(persistence, id, options.signal);
      if (hasConversationContent(orphanCheck)) {
        throw new Error(`cannot resume session "${id}": no pi session is recorded for this Dash session id`);
      }
    }
    if (!blank) {
      // Resume cwd comes from the recorded pairing — re-realpath and
      // re-verify so a moved/removed directory cannot aim a resume outside
      // a live path.
      const verified = validatedCwd(record.cwd);
      if (verified === undefined) {
        throw new Error(`cannot resume session "${id}": its recorded working directory no longer exists`);
      }
    }

    const envMode = envApprovalMode();
    const preset =
      envMode !== undefined
        ? envMode
        : record?.preset ??
        presetFromEvents(orphanCheck ?? await readStoredEvents(persistence, id, options.signal)) ??
        defaultPermissionPreset(loopCtx);
    const toolset = piToolset(preset);
    const spawnCwd = blank
      ? (record !== undefined ? validatedCwd(record.cwd) ?? process.cwd() : process.cwd())
      : validatedCwd(record.cwd) as string;
    trace(`resume id=${id}${blank ? " (blank → fresh lazy shell)" : ` file=${record.sessionFile}`} spawnCwd=${spawnCwd} preset=${preset ?? "none"}`);

    // Re-attach to the pi session by its native file (pi owns the live agent
    // context and keeps generating it from here on; the model context is
    // restored by pi itself from its transcript). A blank session gets the
    // CREATE-shaped lazy shell — zero pi objects until the first prompt.
    const client = await PiSessionClient.spawn([], spawnCwd, blank
      ? { kind: "create", ...(toolset === undefined ? {} : { tools: toolset }) }
      : { kind: "resume", sessionFile: record.sessionFile });

    let handle: SessionHandle | undefined;
    let stored: StoredSession | undefined;
    let preparation: SessionPreparation | undefined;
    let handedOff = false;
    try {
      // Taking write ownership FIRST excludes a concurrent resume of the
      // same id (a live agent's handle holds the claim in this process).
      handle = await persistence.open(id, "write", options.signal === undefined ? {} : { signal: options.signal });
      // Crash repair belongs to the agent layer: an interrupted final turn
      // receives synthetic closers appended through the same handle.
      const cold = await handle.read(0, undefined, options.signal === undefined ? {} : { signal: options.signal });
      const closers = interruptedTurnClosers(cold.events);
      if (closers.length > 0) await handle.append(closers);
      preparation = SessionPreparation.create(loopCtx.sessions.prepare(id, {
        seed: [...cold.events, ...closers],
        meta: structuredClone(handle.header),
        inheritedEventCount: handle.inheritedEventCount,
        eventState: cold.eventState,
      }));
      stored = { handle, storedCount: cold.events.length + closers.length };
      trace(`resume id=${id} seeded ${cold.events.length} events (+${closers.length} closers)`);
      handle = undefined; // ownership passes to setupAndPublish
      this.followSessionFile(id, client);
      handedOff = true;
      return await setupAndPublish(
        loopCtx,
        ownerCtx,
        id,
        this.sessionAgentOptions(options.agentOptions),
        options.setup,
        preparation.session,
        client,
        options.parentAgent,
        "resume",
        { enterSession: true, preparation },
        stored,
        this.agentRuntime(client),
      );
    } catch (error) {
      trace(`resume ${id} THREW: ${String(error)} | stack=${error instanceof Error ? error.stack?.slice(0, 400) : "n/a"}`);
      client.close();
      if (!handedOff) await handle?.close().catch(() => { });
      throw error;
    } finally {
      if (!handedOff) preparation?.[Symbol.dispose]();
    }
  }

  /**
   * Watch the client for its first materialized session file and persist the
   * Dash↔pi pairing once (the record is the resume authority; the
   * create-time entry starts with `sessionFile: null`).
   * Arrow FIELD (not a `#` method and not a true-private field): the provider
   * is exposed through a Cordis tracing proxy, and hard-private members fail
   * their brand check on the proxy receiver (the same reason setupAndPublish
   * is module-level). A persistence failure here is logged, never thrown
   * into the client's event stream.
   */
  private readonly followSessionFile = (id: SessionId, client: PiSessionClient): void => {
    const observe = (sessionFile: string): void => {
      try {
        upsertSession(this.home, String(id), { sessionFile });
        trace(`session file recorded for ${String(id)}: ${sessionFile}`);
      } catch (error) {
        this.runtime.ctx.logger.warn(`pi-provider: failed to persist the pi session file for ${String(id)}: ${String(error)}`);
      }
    };
    const existing = client.sessionFile;
    if (existing !== null) {
      observe(existing);
      return;
    }
    const off = client.on(() => {
      const observed = client.sessionFile;
      if (observed === null) return;
      observe(observed);
      off();
    });
  };
}

/**
 * Durable flush of the session's pre-publication suffix. Constructor seed
 * markers and setup-window events never re-emit through `session/event`, so
 * publication must push them through the handle before live events start
 * routing into it. Advances by what was stored.
 */
async function appendUnstoredSuffix(stored: StoredSession, session: Session): Promise<void> {
  const suffix = session.snapshotEvents(SessionLogOffset(stored.storedCount));
  if (suffix.length > 0) await stored.handle.append(suffix);
  stored.storedCount += suffix.length;
}

/**
 * Shared creation/resume transaction: build the agent over the prepared
 * session, run unpublished setup, flush the unstored suffix, and publish both
 * in order; the owned storage handle is drained (closed) on teardown. Kept as
 * a module-level function (not a private method) because Cordis exposes the
 * provider through a tracing proxy, which breaks hard-private (`#`) receivers.
 */
async function setupAndPublish(
  loopCtx: Context,
  ownerCtx: Context,
  id: SessionId,
  agentOptions: AgentOptions,
  setup: AgentSetup | undefined,
  session: Session,
  client: PiSessionClient,
  parentAgent: Agent | undefined,
  source: "startup" | "resume",
  opts: { enterSession: boolean; preparation?: SessionPreparation },
  stored: StoredSession,
  runtimeInfo: PiAgentRuntimeInfo,
): Promise<AgentHandle> {
  let detachSession: (() => void) | undefined;
  let detachAgent: (() => void) | undefined;
  let agent: PiAgent | undefined;
  // Late-bound teardown the agent triggers itself after its idle window
  // expires — defined only after publication.
  let idleExit: (() => void) | undefined;
  try {
    // Build the agent shim over the session and the live client.
    agent = new PiAgent(loopCtx, id, agentOptions, session, client, () => idleExit?.(), runtimeInfo);

    // Pin THIS session to the pi route. The global default-model setting is
    // a best-effort push (the settings service may flush late, and a shared
    // test home can hold another line's default), so the factory must not
    // let the first prompt depend on it: `selectForNextRequest` is the same
    // per-session mechanism `session/selectModel` uses.
    try {
      const route = runtimeInfo?.routeContext(agentOptions);
      if (route !== undefined) {
        const selection = { provider: route.provider, model: route.model };
        let picked: typeof selection | undefined = selection;
        installModelSelection(agent.ctx, {
          get current() { return picked },
          set current(next) { picked = next },
          assembled: undefined,
        });
        // `model/selection` is contributed to `SessionEventMap` by the upstream
        // session-controller package (declaration merging); this adapter does
        // not depend on it, so the append goes through a narrow local cast.
        (session.append as (type: string, data: unknown) => unknown)("model/selection", selection);
        trace(`session route pinned: ${route.provider}/${route.model}`);
      }
    } catch (error) {
      // Fail-soft: the boot-time default-model push remains the fallback.
      trace(`session route pin failed: ${String(error)}`);
    }

    // Session identity (the preset stamp) and pi's system prompt commit on
    // the first turn via PiAgent's #bootstrapSessionIdentity /
    // #emitSystemMessage: a freshly created session announces completely
    // blank, so the backend takes zero part in the UI's new-session draft.

    // Composition-only setup on the unpublished agent scope.
    const commit = await setup?.(agent.ctx, agent);

    // Publish: flush the unstored suffix (seed + setup-window events) through
    // the owned handle, then enter both session and agent, announce in order,
    // and signal session-start. The commit runs immediately before
    // publication.
    commit?.commit();
    await appendUnstoredSuffix(stored, session);

    if (opts.enterSession) {
      detachSession = agent.ctx.sessions.enter(session);
      agent.ctx.sessions.announce(session);
    }
    detachAgent = loopCtx.agents.enter(agent, parentAgent);
    // 0.1.6: announce(agent, source) is required, async, and emits agent/created
    // itself — the manual agent/session-start emission is gone upstream.
    await loopCtx.agents.announce(agent, source);

    let disposed = false;
    let unfollowOwner: (() => void) | undefined;
    const dispose = async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      trace(`dispose() called for agent ${id} (source=${source})`);
      unfollowOwner?.();
      await agent?.dispose();
      detachAgent?.();
      detachSession?.();
      // Drain queued appends; a durability failure surfaces to the caller.
      await stored.handle.close();
    };
    idleExit = () => {
      void dispose().catch((error) => {
        loopCtx.logger.warn(`pi-provider: teardown of ${id} failed: ${String(error)}`);
      });
    };

    // Follow the owner: a caller-fiber unload tears this agent down.
    unfollowOwner = ownerCtx.effect(() => () => {
      void dispose().catch((error) => {
        loopCtx.logger.warn(`pi-provider: owner-unload teardown of ${id} failed: ${String(error)}`);
      });
    }, `piProvider.lifecycle(${id})`);

    return { agent, dispose };
  } catch (error) {
    // Unwind the half-published transaction. A failure between `enter` and
    // the announcements must not leave a live-but-dead entry the API
    // resolver would serve.
    trace(`setupAndPublish ${id} FAILED: ${String(error)}`);
    detachAgent?.();
    detachSession?.();
    void agent?.dispose().catch(() => { });
    client.close();
    throw error;
  } finally {
    // Release the preparation's per-id reservation on every path.
    opts.preparation?.[Symbol.dispose]();
  }
}

export default PiProvider;
