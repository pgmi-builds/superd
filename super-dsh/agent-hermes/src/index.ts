/**
 * agent-hermes provider — Hermes provider plugin for DeepSeek Harness
 * (Agent Worlds AW-H, TUI gateway line).
 *
 * Replaces the built-in agent loop with an `AgentFactory` that drives a
 * `HermesGatewayClient` (one spawned `python -m tui_gateway.entry` child per
 * session) and bridges the projected wire stream into the Dash Agent/Session
 * contracts. Mirrors `@deepseek-ai/dsh-agent-loop`'s creation transaction
 * (prepare → owned storage handle → setup → publish) so the session + agent
 * publish as one ordered lifecycle AND the DSH session log is written through
 * the upstream `sessionPersistence` service.
 *
 * Session identity (2026-09-17, "mapping only"): the DSH session id is the
 * authority — supplied by the harness at create (`options.sessionId`) and
 * resume (`options.resumeSessionId`). The gateway's session id only
 * materializes after the first prompt, so the pairing is persisted in the
 * adapter's DSH-side app dir (`<home>/dsh-sessions.json`, see hermes-store.ts).
 * Resume resolves that record and fails closed when the gateway session is
 * unknown. Lazy materialization: `createAgent` spawns the gateway child but
 * binds NO gateway session — the FIRST prompt does `ensureStarted()` +
 * `createSession` (fresh) / `resumeSession` (re-attach), and
 * `followGatewaySessionId` upserts the map once the session id materializes.
 */
import { realpathSync, statSync } from "node:fs";
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
import { emitAgentEvent, installModelSelection } from "@deepseek-ai/dsh-agent";
import type { LlmRuntime } from "@deepseek-ai/dsh-llm";
import {
  SessionLogOffset,
  SessionPreparation,
  interruptedTurnClosers,
  type Session,
  type SessionEvent,
  type SessionId,
} from "@deepseek-ai/dsh-session";
import type { SessionHandle, SessionPersistence } from "@deepseek-ai/dsh-session-persistence";
import { HermesGatewayClient, HERMES_SPAWN_GRACE_MS } from "./hermes-client.js";
import { HermesAgent, type HermesAgentRuntimeInfo } from "./agent.js";
import { HermesLlmAdapter, HERMES_PROVIDER_ID } from "./adapter.js";
import { SingleHermesPresetRoster } from "./agent-preset-hermes.js";
import { hermesAgentPresetProjection } from "./agent-preset-projection.js";
import { sessionRecord, upsertSession } from "./hermes-store.js";
import { hermesProviderSlugs, readHermesModelCatalog, type HermesCatalog } from "./models.js";
import { envApprovalMode, defaultPermissionPreset, presetFromEvents } from "./permission.js";

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

/** Diagnostic trace (HERMES_TRACE=1 on the dsh process enables stderr tracing). */
const trace = (...parts: unknown[]): void => {
  if (process.env.HERMES_TRACE === "1") process.stderr.write(`[hermes-provider ${Date.now() % 1_000_000}] ${parts.join(" ")}\n`);
};

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

export class HermesProvider extends Service implements AgentFactory {
  /**
   * `agentDefaultModel` and `settings` are load-bearing, not decorative (OMP
   * twin, same boot-order trap): the harness owns the "default for new sessions"
   * selection there, and this bridge is the only thing that feeds it the hermes
   * config's real default. Without the inject the context cannot resolve the
   * service at apply time and the push in #registerDefaultModel never fires.
   */
  static inject: string[] = ["agents", "sessions", "llm", "agentDefaultModel", "settings"];

  /** Plain holder — prevents Cordis re-tracing the factory's ctx through a caller shadow. */
  private readonly runtime: { ctx: Context };
  /**
   * The world's DSH home — captured once from the world's own `dshHomePath`
   * (never ambient env inside plugins). It anchors adapter-owned DSH state
   * (the session map) only; the hermes runtime keeps its native `~/.hermes`
   * home (2026-09-17 ruling).
   */
  private readonly home: string;
  /** Echo/staleness guard for the app-wide default-model push. */
  private defaultModelKey = "";
  /** Memoized async catalog (probe-client-then-close, resolved once per process). */
  private catalogPromise: Promise<HermesCatalog> | undefined;

  constructor(ctx: Context) {
    super(ctx, "hermesProvider");
    this.runtime = { ctx };
    // Native-home ruling (2026-09-17): the Hermes runtime keeps its own native
    // home (~/.hermes), never redirected. this.home is only the world's DSH
    // home, anchoring adapter-owned DSH state (the session map).
    this.home = this.#resolveHome();
    trace(`home: worldHome=${this.home}`);
    ctx.effect(() => ctx.agents.setFactory(this), "hermesProvider.setFactory()");
    this.#registerModelCatalog();
    this.#registerDefaultModel();
    // The roster must be visible to the API gateway's root-level remote
    // enumeration; register it on this plugin's own (top-level) fiber.
    new SingleHermesPresetRoster(ctx);
    // Drive the `agentPreset` session projection ourselves.
    ctx.inject(["sessionProjections"], (scoped: Context) => {
      scoped.sessionProjections.register(hermesAgentPresetProjection);
    });
  }

  /**
   * The factory owns its sessions' route (user directive 2026-09-15,
   * restated 2026-09-17): the ambient `agentDefaultModel` selection is NOT
   * authoritative here — a session created by this factory always runs on the
   * gateway's real default route {provider: slug, model: id} unless the caller
   * asked for a model this factory serves (a gateway provider slug, or the
   * legacy `hermes` placeholder). The pair is canonicalized through the
   * catalog entry (the r4 dedupe gives each id ONE provider route, so the
   * pinned route always resolves), and ids stay the VERBATIM gateway
   * selection strings. Unavailable catalog → no route fields (the placeholder
   * never leaks — the hermes config default applies).
   */
  private async sessionAgentOptions(requested: AgentOptions | undefined): Promise<AgentOptions> {
    const catalog = await this.catalog();
    const requestedProvider = requested?.provider;
    const requestedModel = typeof requested?.model === "string" ? requested.model : undefined;
    const providerServed = requestedProvider === HERMES_PROVIDER_ID ||
      (requestedProvider !== undefined && catalog.models.some((entry) => entry.provider === requestedProvider));
    const explicit = providerServed && requestedModel !== undefined && requestedModel !== "" ? requestedModel : undefined;
    const model = explicit ?? catalog.defaultModel;
    if (model === undefined) return { ...(requested ?? {}) };
    // Canonical route: the model's catalog entry pins the real provider slug.
    const entry = catalog.models.find((candidate) => candidate.id === model);
    const provider =
      entry?.provider ??
      (explicit && requestedProvider !== undefined && requestedProvider !== HERMES_PROVIDER_ID
        ? requestedProvider // advisory catalog: pass the served slug through unlisted
        : catalog.provider);
    return { ...(requested ?? {}), provider, model };
  }

  /** The memoized async catalog (probe-client-then-close, resolved once). */
  private catalog(): Promise<HermesCatalog> {
    if (this.catalogPromise === undefined) {
      this.catalogPromise = this.#probeCatalog();
    }
    return this.catalogPromise;
  }

  /**
   * Probe the gateway `model.options` once and close the probe client. The
   * probe client is the ONLY spawn that arms the idle-probe reaper (explicit
   * spawnGraceMs): it never materializes a session on purpose, so the grace
   * bounds it. Agent-held clients (createAgent/resume) never pass it.
   */
  async #probeCatalog(): Promise<HermesCatalog> {
    const client = HermesGatewayClient.spawn({ spawnGraceMs: HERMES_SPAWN_GRACE_MS });
    try {
      return await readHermesModelCatalog(client);
    } finally {
      client.close();
    }
  }

  /**
   * The write path is mandatory now (2026-09-16): this factory owns the DSH
   * session log through the upstream persistence service.
   */
  private requirePersistence(op: "create" | "resume"): SessionPersistence {
    const persistence = this.runtime.ctx.get("sessionPersistence") as SessionPersistence | undefined;
    if (persistence === undefined) {
      throw new Error(`cannot ${op} a Hermes session: session persistence is not configured`);
    }
    return persistence;
  }

  /** Take a fresh session's write ownership (nothing is appended here). */
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
   * Runtime facts the agent stamps into the log: Hermes's own system prompt
   * (the settled `session.info` payload's `system_prompt`, captured by the
   * client once non-empty) and the effective route metadata (selected hermes
   * model, else the catalog default, plus the catalog's context window).
   */
  private agentRuntime(
    client: HermesGatewayClient,
    cwd: string,
    resumeStoredSessionId: string | null = null,
  ): HermesAgentRuntimeInfo {
    return {
      systemPrompt: (): string | undefined => {
        const prompt = client.systemPrompt;
        return prompt === "" ? undefined : prompt;
      },
      sessionTitle: (): string | undefined => {
        const title = client.title;
        return title === "" ? undefined : title;
      },
      routeContext: async (selection: { provider?: string; model?: string } | undefined) => {
        const catalog = await this.catalog();
        const model = selection?.model !== undefined && selection.model !== "" ? selection.model : catalog.defaultModel;
        if (model === undefined) return undefined;
        // Canonical route: the entry pins the real provider slug (r4 dedupe
        // gives each id exactly one). A provider-matched find honors an
        // explicit selection; the id-only fallback covers legacy/stale pairs.
        const entry =
          catalog.models.find(
            (candidate) => candidate.id === model && (selection?.provider === undefined || candidate.provider === selection.provider),
          ) ?? catalog.models.find((candidate) => candidate.id === model);
        return {
          provider: entry?.provider ?? selection?.provider ?? catalog.provider,
          model,
          ...(entry?.contextWindow !== undefined && entry.contextWindow > 0 ? { contextWindow: entry.contextWindow } : {}),
        };
      },
      session: { cwd, resumeStoredSessionId },
    };
  }

  /** The world's DSH home: boot-provided dshHomePath first, env last. */
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
   * Push the gateway's default model into the world's `agentDefaultModel`
   * (one-directional on purpose). The catalog is async, so the push resolves
   * through the memoized promise; `defaultModel === undefined` (unavailable
   * catalog) skips — the placeholder never leaks outward.
   */
  #registerDefaultModel(): void {
    this.runtime.ctx.inject(["agentDefaultModel", "settings"], (mCtx) => {
      const service = mCtx.get("agentDefaultModel") as
        | {
          currentSelection?: () => { provider: string; model: string };
          saveSelection?: (selection: { provider: string; model: string }) => Promise<unknown>;
        }
        | undefined;
      if (service === undefined) return;
      void this.catalog()
        .then((catalog) => {
          if (catalog.defaultModel === undefined) {
            trace("default model push skipped: catalog default unavailable");
            return;
          }
          // Real-slug route (2026-09-17 parity ruling): the default model's
          // canonical catalog entry pins the gateway provider slug; the
          // top-level `provider` string is the fallback when the id is
          // somehow unlisted. Ordering note: #registerModelCatalog ran first
          // at boot, so its handle.replace (placeholder → real slugs) on the SAME memoized
          // promise has already swapped the routes in before this push fires.
          const entry = catalog.models.find((candidate) => candidate.id === catalog.defaultModel);
          const target = { provider: entry?.provider ?? catalog.provider, model: catalog.defaultModel };
          const targetKey = `${target.provider}/${target.model}`;
          const current = service.currentSelection?.();
          const currentKey = current === undefined ? undefined : `${current.provider}/${current.model}`;
          if (currentKey === targetKey || currentKey === this.defaultModelKey) return;
          trace(`default model: ${currentKey ?? "none"} → ${targetKey}`);
          const settings = mCtx.get("settings") as
            | { replace?: (namespace: string, value: unknown) => Promise<unknown> }
            | undefined;
          void Promise.resolve(settings?.replace?.("agent-default-model", target))
            .then(() => service.saveSelection?.(target))
            .then(() => {
              this.defaultModelKey = targetKey;
              this.runtime.ctx.logger.info(`hermes-provider: default model ← hermes catalog: ${targetKey}`);
            })
            .catch((error) => {
              this.runtime.ctx.logger.warn(`hermes-provider: default model save failed: ${String(error)}`);
            });
        })
        .catch((error) => {
          this.runtime.ctx.logger.warn(`hermes-provider: catalog probe failed: ${String(error)}`);
        });
    });
  }

  /**
   * Register the Hermes-backed LLM adapter: the single placeholder route
   * `hermes` at boot (the selector is alive while the async probe runs), then
   * an ATOMIC swap to the distinct real provider slugs once the first catalog
   * probe resolves (`AdapterRegistrationHandle.replace` — validated in full,
   * one synchronous section, no observable gap). 2026-09-17 parity ruling.
   */
  #registerModelCatalog(): void {
    const llm = this.runtime.ctx.get("llm") as LlmRuntime | undefined;
    if (llm === undefined) return;
    // The adapter resolves the async catalog through the memoized supplier.
    const handle = llm.registerAdapter([HERMES_PROVIDER_ID], new HermesLlmAdapter(() => this.catalog()));
    // Registered BEFORE #registerDefaultModel in the constructor, so this
    // .then runs before the default-model push on the same memoized promise:
    // the pushed {provider, model} route always resolves by the time it lands.
    void this.catalog()
      .then((catalog) => {
        const slugs = hermesProviderSlugs(catalog);
        if (slugs.length === 0) {
          this.runtime.ctx.logger.warn("hermes-provider: catalog probe empty — the placeholder hermes route stays");
          return;
        }
        handle.replace(slugs);
        this.runtime.ctx.logger.info(`hermes-provider: model routes ← ${slugs.length} gateway provider groups (${slugs.join(", ")})`);
      })
      .catch((error) => {
        this.runtime.ctx.logger.warn(`hermes-provider: model route swap failed: ${String(error)}`);
      });
  }


  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    const loopCtx = this.runtime.ctx;
    const id = options.sessionId;
    const meta = options.meta ?? {};
    const cwd = meta.cwd;

    // Fork: Hermes has no native fork (session.branch is a P2 gap).
    if (meta.parentSession !== undefined) {
      throw new Error(
        `cannot fork session "${meta.parentSession}" onto the Hermes provider: Hermes has no native session fork`,
      );
    }

    const persistence = this.requirePersistence("create");

    // The preset is record-only (no launch flag — approval is runtime).
    const preset = envApprovalMode() ?? defaultPermissionPreset(loopCtx);
    const spawnCwd = validatedCwd(cwd) ?? process.cwd();
    trace(`create id=${id} preset=${preset ?? "none"} spawnCwd=${spawnCwd}${envApprovalMode() === undefined ? "" : " (env override)"}`);

    // Lazy session materialization (ruling 1): spawn the gateway child (no
    // session bound), record the pairing with gatewaySessionId:null. The FIRST
    // prompt materializes the gateway session via createSession.
    // Agent-held client: the spawn-grace reaper is NEVER armed here (2026-09-17
    // ruling 4 — the session may legitimately materialize far beyond any
    // grace; disposal is the agent lifecycle's job, not a timer's).
    const client = HermesGatewayClient.spawn({ cwd: spawnCwd, lazy: true }) // full-lazy ruling 2026-09-18: view/create-time spawns NOTHING;

    const preparation = SessionPreparation.create(loopCtx.sessions.prepare(id, {
      ...(options.seed === undefined ? {} : { seed: options.seed }),
      ...(meta === undefined ? {} : { meta }),
      ...(options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount }),
    }));
    let stored: StoredSession | undefined;
    let handedOff = false;
    try {
      stored = await this.createStoredSession(persistence, preparation.session, options.signal);
      upsertSession(this.home, String(id), {
        gatewaySessionId: null,
        cwd: spawnCwd,
        createdAt: Date.now(),
        preset: preset ?? null,
      });
      this.followGatewaySessionId(id, client);
      handedOff = true;
      const agentOptions = await this.sessionAgentOptions(options.agentOptions);
      return await setupAndPublish(
        loopCtx,
        ownerCtx,
        id,
        agentOptions,
        options.setup,
        preparation.session,
        client,
        options.parentAgent,
        "startup",
        { enterSession: true, preparation },
        stored,
        this.agentRuntime(client, spawnCwd),
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

    // Identity (2026-09-17 "mapping only"): the DSH session id resolves through
    // the adapter-owned map. A missing record (or a never-materialized gateway
    // session) is a genuine unknown: fail closed with the DSH id in the message.
    const record = sessionRecord(this.home, String(id));
    trace(`resume id=${id} record=${record === undefined ? "MISSING" : record.gatewayStoredSessionId ?? "NO-STORED-ID"}`);
    if (record === undefined) {
      throw new Error(`cannot resume session "${id}": no Hermes gateway session is recorded for this Dash session id`);
    }
    if (record.gatewayStoredSessionId === null || record.gatewayStoredSessionId === undefined) {
      throw new Error(`cannot resume session "${id}": no durable gateway session id is recorded (this record predates durable-id capture; re-create the session)`);
    }

    // Spawn cwd comes from the recorded pairing — re-realpath and re-verify.
    const spawnCwd = validatedCwd(record.cwd);
    if (spawnCwd === undefined) {
      throw new Error(`cannot resume session "${id}": its recorded working directory no longer exists`);
    }

    const persistence = this.requirePersistence("resume");

    // Preset (record-only): env override, else the recorded preset, else the
    // persisted session log, else the permission service's default.
    const envMode = envApprovalMode();
    const preset =
      envMode !== undefined
        ? envMode
        : record.preset ??
        presetFromEvents(await readStoredEvents(persistence, id, options.signal)) ??
        defaultPermissionPreset(loopCtx);
    trace(`resume id=${id} spawnCwd=${spawnCwd} preset=${preset ?? "none"}`);

    // Spawn the gateway child (no session bound); the FIRST prompt re-attaches
    // via resumeSession(record.gatewayStoredSessionId) — the DURABLE key.
    const client = HermesGatewayClient.spawn({ cwd: spawnCwd, lazy: true }) // full-lazy ruling 2026-09-18: view/create-time spawns NOTHING;

    let handle: SessionHandle | undefined;
    let stored: StoredSession | undefined;
    let preparation: SessionPreparation | undefined;
    let handedOff = false;
    try {
      handle = await persistence.open(id, "write", options.signal === undefined ? {} : { signal: options.signal });
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
      this.followGatewaySessionId(id, client);
      handedOff = true;
      const agentOptions = await this.sessionAgentOptions(options.agentOptions);
      return await setupAndPublish(
        loopCtx,
        ownerCtx,
        id,
        agentOptions,
        options.setup,
        preparation.session,
        client,
        options.parentAgent,
        "resume",
        { enterSession: true, preparation },
        stored,
        this.agentRuntime(client, spawnCwd, record.gatewayStoredSessionId),
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
   * Persist the Dash↔gateway pairing at session ADOPTION (the
   * session.create/resume response — the materialization moment) and tolerate
   * `stored_session_id` DRIFT: the gateway may remint the durable key on
   * resume, so the upsert always tracks the latest adopted pair (2026-09-17
   * ruling). Arrow FIELD (not a `#` method): the provider is exposed through
   * a Cordis tracing proxy.
   */
  private readonly followGatewaySessionId = (id: SessionId, client: HermesGatewayClient): void => {
    const observe = (): void => {
      const live = client.sessionId;
      const stored = client.storedSessionId;
      if (live === null && stored === null) return;
      try {
        upsertSession(this.home, String(id), {
          ...(live === null ? {} : { gatewaySessionId: live }),
          ...(stored === null ? {} : { gatewayStoredSessionId: stored }),
        });
        trace(`gateway ids recorded for ${String(id)}: live=${live ?? "none"} stored=${stored ?? "none"}`);
      } catch (error) {
        this.runtime.ctx.logger.warn(`hermes-provider: failed to persist the gateway ids for ${String(id)}: ${String(error)}`);
      }
    };
    observe();
    const off = client.onAdopted(() => {
      observe();
      off();
    });
  };
}

/** Durable flush of the session's pre-publication suffix. */
async function appendUnstoredSuffix(stored: StoredSession, session: Session): Promise<void> {
  const suffix = session.snapshotEvents(SessionLogOffset(stored.storedCount));
  if (suffix.length > 0) await stored.handle.append(suffix);
  stored.storedCount += suffix.length;
}

/**
 * Shared creation/resume transaction: build the agent over the prepared
 * session, run unpublished setup, flush the unstored suffix, and publish both
 * in order. Kept as a module-level function (not a private method) because
 * Cordis exposes the provider through a tracing proxy.
 */
async function setupAndPublish(
  loopCtx: Context,
  ownerCtx: Context,
  id: SessionId,
  agentOptions: AgentOptions,
  setup: AgentSetup | undefined,
  session: Session,
  client: HermesGatewayClient,
  parentAgent: Agent | undefined,
  source: "startup" | "resume",
  opts: { enterSession: boolean; preparation?: SessionPreparation },
  stored: StoredSession,
  runtimeInfo: HermesAgentRuntimeInfo,
): Promise<AgentHandle> {
  let detachSession: (() => void) | undefined;
  let detachAgent: (() => void) | undefined;
  let agent: HermesAgent | undefined;
  let idleExit: (() => void) | undefined;
  try {
    agent = new HermesAgent(loopCtx, id, agentOptions, session, client, () => idleExit?.(), runtimeInfo);

    // Pin THIS session to the hermes route. The route resolves through the
    // async catalog (the memoized promise), so this is awaited before the first
    // prompt — `selectForNextRequest` is the same per-session mechanism
    // `session/selectModel` uses.
    try {
      const route = await runtimeInfo?.routeContext({ provider: agentOptions.provider, model: agentOptions.model });
      if (route !== undefined) {
        const selection = { provider: route.provider, model: route.model };
        let picked: typeof selection | undefined = selection;
        installModelSelection(agent.ctx, {
          get current() { return picked },
          set current(next) { picked = next },
          assembled: undefined,
        });
        (session.append as (type: string, data: unknown) => unknown)("model/selection", selection);
        trace(`session route pinned: ${route.provider}/${route.model}`);
      }
    } catch (error) {
      // Fail-soft: the boot-time default-model push remains the fallback.
      trace(`session route pin failed: ${String(error)}`);
    }

    const commit = await setup?.(agent.ctx, agent);

    commit?.commit();
    await appendUnstoredSuffix(stored, session);

    if (opts.enterSession) {
      detachSession = agent.ctx.sessions.enter(session);
      agent.ctx.sessions.announce(session);
    }
    detachAgent = loopCtx.agents.enter(agent, parentAgent);
    loopCtx.agents.announce(agent);
    emitAgentEvent(loopCtx, agent, "agent/session-start", { source });

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
      await stored.handle.close();
    };
    idleExit = () => {
      void dispose().catch((error) => {
        loopCtx.logger.warn(`hermes-provider: teardown of ${id} failed: ${String(error)}`);
      });
    };

    unfollowOwner = ownerCtx.effect(() => () => {
      void dispose().catch((error) => {
        loopCtx.logger.warn(`hermes-provider: owner-unload teardown of ${id} failed: ${String(error)}`);
      });
    }, `hermesProvider.lifecycle(${id})`);

    return { agent, dispose };
  } catch (error) {
    trace(`setupAndPublish ${id} FAILED: ${String(error)}`);
    detachAgent?.();
    detachSession?.();
    void agent?.dispose().catch(() => { });
    client.close();
    throw error;
  } finally {
    opts.preparation?.[Symbol.dispose]();
  }
}

export default HermesProvider;
