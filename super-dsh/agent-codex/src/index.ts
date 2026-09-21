/**
 * agent-codex provider — Codex provider plugin for DeepSeek Harness
 * (Agent Worlds AW-E, SDK line).
 *
 * Replaces the built-in agent loop with an `AgentFactory` that drives
 * `@openai/codex-sdk` threads (one `CodexSdkClient` per session) and bridges
 * the projected wire stream into the Dash Agent/Session contracts. Mirrors
 * `@deepseek-ai/dsh-agent-loop`'s creation transaction (prepare → owned
 * storage handle → setup → publish) so the session + agent publish as one
 * ordered lifecycle AND the DSH session log is written through the upstream
 * `sessionPersistence` service — list/read/replay/workspace grouping are then
 * ordinary DSH services over that log.
 *
 * Session identity (2026-09-16, "mapping only"): the DSH session id is the
 * authority — supplied by the harness at create (`options.sessionId`) and
 * resume (`options.resumeSessionId`). Codex's thread id only materializes
 * after the first turn, so the pairing is persisted in the adapter's app home
 * (`<codexHome>/dsh-sessions.json`, see session-map.ts). Resume resolves that
 * record and fails closed when the thread is unknown. The rollout scan, the
 * adapter-owned session list and the transcript replay are gone.
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
import { CodexSdkClient } from "./codex-client.js";
import { CodexAgent, type CodexAgentRuntimeInfo } from "./agent.js";
import { CodexLlmAdapter, CODEX_PROVIDER_ID } from "./adapter.js";
import { SingleCodexPresetRoster } from "./agent-preset-codex.js";
import { codexAgentPresetProjection } from "./agent-preset-projection.js";
import { readRolloutHead, resolveCodexHome } from "./codex-store.js";
import { CodexResumeError, sessionRecord, upsertSession, type CodexSessionRecord } from "./session-map.js";
import { readCodexModelCatalog, CODEX_DEFAULT_MODEL_PLACEHOLDER } from "./models.js";
import { codexApprovalMode, defaultPermissionPreset, envApprovalMode, presetFromEvents } from "./permission.js";

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

/** Diagnostic trace (CODEX_TRACE=1 on the dsh process enables stderr tracing). */
const trace = (...parts: unknown[]): void => {
  if (process.env.CODEX_TRACE === "1") process.stderr.write(`[codex-provider ${Date.now() % 1_000_000}] ${parts.join(" ")}\n`);
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

export class CodexProvider extends Service implements AgentFactory {
  /**
   * `agentDefaultModel` and `settings` are load-bearing, not decorative (OMP
   * twin, same boot-order trap): the harness owns the "default for new sessions"
   * selection there (`@deepseek-ai/dsh-agent-default-model`, mounted by dsh-base
   * with a hard-coded `deepseek-official/deepseek-flash`), and this bridge is the
   * only thing that feeds it the codex config's real default. Without the inject
   * the context cannot resolve the service at apply time and the push in
   * #registerDefaultModel never fires — the picker keeps advertising a model no
   * adapter in this world serves.
   */
  static inject: string[] = ["agents", "sessions", "llm", "agentDefaultModel", "settings"];

  /** Plain holder — prevents Cordis re-tracing the factory's ctx through a caller shadow. */
  private readonly runtime: { ctx: Context };
  /**
   * The world's DSH home — captured once from the world's own `dshHomePath`
   * (never ambient env inside plugins). It anchors adapter-owned DSH state
   * (the session map) only; the codex app home is the CLI's native `~/.codex`
   * (2026-09-17 ruling), resolved on demand via resolveCodexHome().
   */
  private readonly home: string;
  /** Echo/staleness guard for the app-wide default-model push. */
  private defaultModelKey = "";

  constructor(ctx: Context) {
    super(ctx, "codexProvider");
    this.runtime = { ctx };
    // Native-home ruling (2026-09-17): the Codex CLI keeps its own native home
    // (~/.codex; $CODEX_HOME overrides in tests) — the adapter never redirects
    // it and never seeds config into it. this.home is only the world's DSH
    // home, anchoring adapter-owned DSH state (the session map).
    this.home = this.#resolveHome();
    const codexHome = resolveCodexHome();
    trace(`home: worldHome=${this.home} codexHome=${codexHome} configExists=${existsSync(join(codexHome, "config.toml"))}`);
    ctx.effect(() => ctx.agents.setFactory(this), "codexProvider.setFactory()");
    this.#registerModelCatalog();
    this.#registerDefaultModel();
    // The roster must be visible to the API gateway's root-level remote
    // enumeration (dsh-host-apiproxy read it from the root service table);
    // nesting it under a child fiber via ctx.plugin hides its @Remote routes
    // from the gateway and every agentPresets/* call 404s. Register it on
    // this plugin's own (top-level) fiber instead — its Service constructor
    // ties teardown to this fiber via reflect.provide.
    new SingleCodexPresetRoster(ctx);
    // Drive the `agentPreset` session projection ourselves: the upstream
    // registrant lives in the (disabled) dsh-agent-presets package, but the
    // Web UI gates the preset chip and header label on
    // `projectionValues.agentPreset`. Deferred via inject so the registry's
    // service contract is honored (registers only once it exists).
    ctx.inject(["sessionProjections"], (scoped: Context) => {
      scoped.sessionProjections.register(codexAgentPresetProjection);
    });
  }

  /**
   * The factory owns its sessions' route (user directive 2026-09-15): the
   * ambient `agentDefaultModel` selection is NOT authoritative here — a
   * session created by this factory always runs on the codex route, with the
   * codex config's real default model unless the caller asked for a served
   * codex model. Without an explicit choice the model rides the thread
   * options only when the catalog is readable (the placeholder is omitted so
   * codex's own config default applies).
   */
  private sessionAgentOptions(requested: AgentOptions | undefined): AgentOptions {
    const catalog = readCodexModelCatalog(resolveCodexHome());
    const explicit = requested?.provider === CODEX_PROVIDER_ID && typeof requested.model === "string" && requested.model !== CODEX_DEFAULT_MODEL_PLACEHOLDER
      ? requested.model
      : undefined;
    const model = explicit ?? (catalog.defaultModel === CODEX_DEFAULT_MODEL_PLACEHOLDER ? undefined : catalog.defaultModel);
    return { ...(requested ?? {}), provider: CODEX_PROVIDER_ID, ...(model === undefined ? {} : { model }) };
  }

  /**
   * The write path is mandatory now (2026-09-16): this factory owns the DSH
   * session log through the upstream persistence service — a session created
   * or resumed without a backend would persist nothing.
   */
  private requirePersistence(op: "create" | "resume"): SessionPersistence {
    const persistence = this.runtime.ctx.get("sessionPersistence") as SessionPersistence | undefined;
    if (persistence === undefined) {
      throw new Error(`cannot ${op} a Codex session: session persistence is not configured`);
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
   * Runtime facts the agent stamps into the log: Codex's own system prompt
   * (rollout HEAD `base_instructions`, readable once the thread exists) and
   * the effective route metadata (selected codex model, else the catalog
   * default, plus the catalog's context window).
   */
  private agentRuntime(client: CodexSdkClient, id: SessionId): CodexAgentRuntimeInfo {
    const codexHome = resolveCodexHome();
    return {
      systemPrompt: (): string | undefined => {
        const threadId = client.threadId;
        if (threadId === null) return undefined;
        return readRolloutHead(codexHome, threadId)?.baseInstructions;
      },
      routeContext: (preferredModel: string | undefined) => {
        const catalog = readCodexModelCatalog(codexHome);
        const model = preferredModel !== undefined && preferredModel !== "" && preferredModel !== CODEX_DEFAULT_MODEL_PLACEHOLDER
          ? preferredModel
          : catalog.defaultModel === CODEX_DEFAULT_MODEL_PLACEHOLDER
            ? undefined
            : catalog.defaultModel;
        if (model === undefined) return undefined;
        const entry = catalog.models.find((candidate) => candidate.id === model);
        return {
          provider: CODEX_PROVIDER_ID,
          model,
          ...(entry?.contextWindow !== undefined && entry.contextWindow > 0 ? { contextWindow: entry.contextWindow } : {}),
        };
      },
      // RC-4: turn-time native rejections mark the map so the next resume
      // fails fast (CodexResumeError NATIVE_REJECTED) instead of burning
      // another turn on a dead thread.
      markNotResumable: (): void => {
        try {
          upsertSession(this.home, String(id), { resumable: false });
          this.runtime.ctx.logger.warn(`codex-provider: session ${String(id)} marked not resumable after a native rejection`);
        } catch (error) {
          this.runtime.ctx.logger.warn(`codex-provider: failed to mark ${String(id)} not resumable: ${String(error)}`);
        }
      },
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
   * App-wide wiring the adapter owns (user 2026-09-15): the SDK has no
   * default-model concept, so the bridge publishes the codex config.toml
   * default into the world's `agentDefaultModel`. One-directional on purpose —
   * the config is read-only for us (S7 single-direction valve), which makes the
   * codex world's default sticky. Echo-guarded by the saved key.
   *
   * Why the write goes through `settings.replace` and not through
   * `agentDefaultModel.saveSelection`: the harness service installs its section
   * from an `inject(["settings"], …)` callback but then writes through
   * `this.ctx.get("settings")?.replace(…)` on its UNSCOPED context, where
   * `settings` is not injected — the optional chain swallows the lookup and the
   * call is a silent no-op (the settings file is never touched, and the picker
   * keeps showing the base default). Same defect and same fix as the OMP twin
   * (`#saveDefaultSelection`): write the installed section directly through our
   * own injected `settings` service, which the harness folds back via
   * `installSection`, so every other consumer sees the new default.
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
      const catalog = readCodexModelCatalog(resolveCodexHome());
      if (catalog.defaultModel === CODEX_DEFAULT_MODEL_PLACEHOLDER) {
        trace("default model push skipped: catalog unreadable (placeholder)");
        return;
      }
      const target = { provider: CODEX_PROVIDER_ID, model: catalog.defaultModel };
      const targetKey = `${target.provider}/${target.model}`;
      const current = service.currentSelection?.();
      const currentKey = current === undefined ? undefined : `${current.provider}/${current.model}`;
      if (currentKey === targetKey || currentKey === this.defaultModelKey) return;
      trace(`default model: ${currentKey ?? "none"} → ${targetKey}`);
      const settings = mCtx.get("settings") as
        | { replace?: (namespace: string, value: unknown) => Promise<unknown> }
        | undefined;
      void Promise.resolve(settings?.replace?.("agent-default-model", target))
        // Best-effort second path: harmless when upstream's no-op swallows it,
        // and it keeps the in-memory selection fresh on builds where it works.
        .then(() => service.saveSelection?.(target))
        .then(() => {
          this.defaultModelKey = targetKey;
          this.runtime.ctx.logger.info(`codex-provider: default model ← codex config: ${targetKey}`);
        })
        .catch((error) => {
          this.runtime.ctx.logger.warn(`codex-provider: default model save failed: ${String(error)}`);
        });
    });
  }

  #registerModelCatalog(): void {
    const llm = this.runtime.ctx.get("llm") as LlmRuntime | undefined;
    if (llm === undefined) return;
    // The catalog is fail-soft (a `codex-default` placeholder when the home
    // is unreadable), so the route always registers and the selector is
    // never empty.
    llm.registerAdapter([CODEX_PROVIDER_ID], new CodexLlmAdapter(resolveCodexHome()));
  }

  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    const loopCtx = this.runtime.ctx;
    const id = options.sessionId;
    const meta = options.meta ?? {};
    const cwd = meta.cwd;

    // Fork (the apiproxy's `session.fork`) seeds a copied-turn prefix but
    // Codex has no native fork: fail the fork cleanly at the factory boundary.
    // `parentSession` in create metadata is set only by the fork path
    // (subagents go through `ctx.subagents` instead).
    if (meta.parentSession !== undefined) {
      throw new Error(
        `cannot fork session "${meta.parentSession}" onto the Codex provider: Codex has no native session fork`,
      );
    }

    // The DSH session log is this factory's write path (2026-09-16): without
    // the upstream persistence service a created session would persist
    // nothing, so require it up front.
    const persistence = this.requirePersistence("create");

    // Approval policy is pinned at Codex thread construction and the Dash
    // session does not exist yet at this point (it is prepared + announced —
    // which is what stamps `permission/preset` via pinInitialPermission —
    // only inside setupAndPublish, AFTER this spawn), so the effective
    // preset cannot come from session events: the env override
    // (CODEX_APPROVAL_MODE, headless runs) wins, else the permission
    // service's default, mapped onto the launch policy.
    const preset = envApprovalMode() ?? defaultPermissionPreset(loopCtx);
    const approvalPolicy = codexApprovalMode(preset);
    const spawnCwd = validatedCwd(cwd) ?? process.cwd();
    trace(`create id=${id} preset=${preset ?? "none"} approval=${approvalPolicy} spawnCwd=${spawnCwd}${envApprovalMode() === undefined ? "" : " (env override)"}`);

    // Backend takes ZERO part in the UI's browser-local new-session draft
    // beyond the (zero-IO) thread construction: no rollout, no session
    // events — the session announces blank. The thread materializes on the
    // first prompt.
    const client = await CodexSdkClient.spawn(["--approval-mode", approvalPolicy], spawnCwd);
    // Deterministic per-session route (user wiring directive 2026-09-15): the
    // factory owns the model — the catalog's real default rides the first
    // turn; the placeholder (unreadable catalog) is OMITTED so the codex
    // config default applies.
    const createCatalog = readCodexModelCatalog(resolveCodexHome());
    if (createCatalog.defaultModel !== CODEX_DEFAULT_MODEL_PLACEHOLDER) {
      void client.setModel(CODEX_PROVIDER_ID, createCatalog.defaultModel).catch(() => { });
    }

    const preparation = SessionPreparation.create(loopCtx.sessions.prepare(id, {
      ...(options.seed === undefined ? {} : { seed: options.seed }),
      ...(meta === undefined ? {} : { meta }),
      ...(options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount }),
    }));
    let stored: StoredSession | undefined;
    let handedOff = false;
    try {
      stored = await this.createStoredSession(persistence, preparation.session, options.signal);
      // Identity record BEFORE publication: the DSH id → Codex thread pairing
      // (threadId null until the first turn) is what resume resolves.
      upsertSession(this.home, String(id), {
        threadId: client.threadId,
        cwd: spawnCwd,
        createdAt: Date.now(),
        preset: preset ?? null,
      });
      this.followThreadId(id, client);
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
        this.agentRuntime(client, id),
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

    // Identity (2026-09-16 "mapping only", reaffirmed 2026-09-18): the DSH
    // session id resolves through the adapter-owned map — the thread id is
    // recorded when Codex materializes it. The adapter NEVER scans the native
    // ~/.codex session storage to recover pairings (2026-09-18 user ruling:
    // the discovery tier violated the design — DSH log is the transcript
    // authority; the native home contributes config/settings only). Every
    // miss fails closed with a stable code (CodexResumeError).
    const persistence = this.requirePersistence("resume");
    const record = sessionRecord(this.home, String(id));
    trace(`resume id=${id} record=${record === undefined ? "MISSING" : record.threadId ?? "NO-THREAD"}${record?.resumable === false ? " (marked not resumable)" : ""}`);
    if (record === undefined) {
      throw new CodexResumeError(
        "SESSION_MAP_MISS",
        `cannot resume session "${id}": no Codex thread is recorded for this Dash session id`,
      );
    }
    if (record.threadId === null) {
      // C2: never auto-start a fresh thread — the session's history is in the
      // (missing) native thread, not in a blank one.
      throw new CodexResumeError(
        "NATIVE_THREAD_NEVER_STARTED",
        `cannot resume session "${id}": its Codex thread was never started (no thread id recorded)`,
      );
    }
    if (record.resumable === false) {
      // A previous native resume was rejected at turn time (plan RC-4): fail
      // fast with the clear refusal instead of burning another turn.
      throw new CodexResumeError(
        "NATIVE_REJECTED",
        `cannot resume session "${id}": its Codex thread ${record.threadId} was rejected by the native runtime in an earlier attempt`,
      );
    }
    // Pre-validation (plan RC-4): the rollout must exist in the CURRENT codex
    // home BEFORE spawning — covers rollouts stranded under the abandoned
    // `<worldHome>/.codex` home (never migrated) and pruned rollouts alike.
    // Without this gate the failure would surface only at the first turn
    // (resumeThread is zero-IO).
    if (readRolloutHead(resolveCodexHome(), record.threadId) === undefined) {
      throw new CodexResumeError(
        "ROLLOUT_MISSING",
        `cannot resume session "${id}": no rollout for Codex thread ${record.threadId} exists in the current Codex home (${resolveCodexHome()})`,
      );
    }

    // Spawn cwd comes from the recorded pairing — re-realpath and re-verify so
    // a moved/removed directory cannot aim a resume outside a live path.
    const spawnCwd = validatedCwd(record.cwd);
    if (spawnCwd === undefined) {
      throw new Error(`cannot resume session "${id}": its recorded working directory no longer exists`);
    }


    // Approval policy for the re-attached thread: launch-only, so it is
    // decided BEFORE the spawn from the recorded preset, else the persisted
    // session log, else the permission service's default. CODEX_APPROVAL_MODE
    // (headless runs) overrides; no preset → never.
    const envMode = envApprovalMode();
    const preset =
      envMode !== undefined
        ? envMode
        : record.preset ??
        presetFromEvents(await readStoredEvents(persistence, id, options.signal)) ??
        defaultPermissionPreset(loopCtx);
    const approvalPolicy = codexApprovalMode(preset);
    trace(`resume id=${id} spawnCwd=${spawnCwd} preset=${preset ?? "none"} approval=${approvalPolicy}`);

    // Re-attach to the Codex thread by its id (Codex owns the live agent
    // context and keeps generating it from here on; the model context is
    // restored by Codex itself from its rollout).
    const client = await CodexSdkClient.spawn(
      ["--approval-mode", approvalPolicy, "--resume-thread", record.threadId],
      spawnCwd,
    );

    let handle: SessionHandle | undefined;
    let stored: StoredSession | undefined;
    let preparation: SessionPreparation | undefined;
    let handedOff = false;
    try {
      // Taking write ownership FIRST excludes a concurrent resume of the same
      // id (a live agent's handle holds the claim in this process).
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
      this.followThreadId(id, client);
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
        this.agentRuntime(client, id),
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
   * Watch the client for its first materialized thread id and persist the
   * Dash↔thread pairing once (the record is the resume authority; the
   * create-time entry starts with `threadId: null`).
   * Arrow FIELD (not a `#` method and not a true-private field): the provider
   * is exposed through a Cordis tracing proxy, and hard-private members fail
   * their brand check on the proxy receiver (the same reason setupAndPublish
   * is module-level). A persistence failure here is logged, never thrown into
   * the client's event stream.
   */
  private readonly followThreadId = (id: SessionId, client: CodexSdkClient): void => {
    // RE-ARMING observer (plan C6): newSession() swaps threads mid-session, so
    // the pairing must be re-upserted whenever the client's thread id CHANGES,
    // not just once. Unsubscribing after the first capture would leave the map
    // pointing at the discarded thread, and the next resume would re-attach to
    // a thread the session no longer runs on.
    let lastRecorded: string | null = client.threadId;
    const observe = (threadId: string): void => {
      lastRecorded = threadId;
      try {
        upsertSession(this.home, String(id), { threadId });
        trace(`thread id recorded for ${String(id)}: ${threadId}`);
      } catch (error) {
        this.runtime.ctx.logger.warn(`codex-provider: failed to persist the Codex thread id for ${String(id)}: ${String(error)}`);
      }
    };
    if (lastRecorded !== null) observe(lastRecorded);
    client.on(() => {
      const observed = client.threadId;
      if (observed === null || observed === lastRecorded) return;
      observe(observed);
    });
  };
}

/**
 * Durable flush of the session's pre-publication suffix. Constructor seed
 * markers and setup-window events never re-emit through `session/event`, so
 * publication must push them through the handle before live events start
 * routing into it. Advances by what was stored (an event appended during the
 * await stays unstored for the next flush).
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
  client: CodexSdkClient,
  parentAgent: Agent | undefined,
  source: "startup" | "resume",
  opts: { enterSession: boolean; preparation?: SessionPreparation },
  stored: StoredSession,
  runtimeInfo: CodexAgentRuntimeInfo,
): Promise<AgentHandle> {
  let detachSession: (() => void) | undefined;
  let detachAgent: (() => void) | undefined;
  let agent: CodexAgent | undefined;
  // Late-bound teardown the agent triggers itself after its idle window
  // expires (see CodexAgent's idle exit) — defined only after publication.
  let idleExit: (() => void) | undefined;
  try {
    // Build the agent shim over the session and the live client.
    agent = new CodexAgent(loopCtx, id, agentOptions, session, client, () => idleExit?.(), runtimeInfo);

    // Pin THIS session to the codex route. The global default-model setting is
    // a best-effort push (the settings service may flush late, and a shared
    // test home can hold another line's default), so the factory must not let
    // the first prompt depend on it: `selectForNextRequest` is the same
    // per-session mechanism `session/selectModel` uses (appends the log-only
    // `model/selection` and caches the next request's route).
    try {
      const route = runtimeInfo?.routeContext(agentOptions.model);
      if (route !== undefined) {
        const selection = { provider: route.provider, model: route.model };
        // Mirrors the upstream session-controller's `selectForNextRequest`:
        // the durable log-only `model/selection` plus an agent-scoped
        // `ModelSelectionRef` (same shape the controller installs) that the
        // next prompt's route check reads. Synchronous on purpose — the first
        // prompt must not depend on the global default's late flush.
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

    // Session identity (the preset stamp) and the Codex system prompt commit
    // on the first turn via CodexAgent's #bootstrapSessionIdentity /
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
      // Drain queued appends; a durability failure surfaces to the caller
      // (the owner-unload and idle-exit paths log it).
      await stored.handle.close();
    };
    idleExit = () => {
      void dispose().catch((error) => {
        loopCtx.logger.warn(`codex-provider: teardown of ${id} failed: ${String(error)}`);
      });
    };

    // Follow the owner: a caller-fiber unload tears this agent down.
    unfollowOwner = ownerCtx.effect(() => () => {
      void dispose().catch((error) => {
        loopCtx.logger.warn(`codex-provider: owner-unload teardown of ${id} failed: ${String(error)}`);
      });
    }, `codexProvider.lifecycle(${id})`);

    return { agent, dispose };
  } catch (error) {
    // Unwind the half-published transaction. A failure between `enter` and
    // the announcements (e.g. a persistence listener rejecting the session)
    // must not leave a live-but-dead entry the API resolver would serve.
    trace(`setupAndPublish ${id} FAILED: ${String(error)}`);
    detachAgent?.();
    detachSession?.();
    void agent?.dispose().catch(() => { });
    client.close();
    throw error;
  } finally {
    // Release the preparation's per-id reservation on every path (mirrors
    // the reference loop's unconditional dispose): the session it seeded is
    // already published above, so a same-process re-resume of this id can
    // prepare again instead of colliding with a leaked reservation.
    opts.preparation?.[Symbol.dispose]();
  }
}

export default CodexProvider;
