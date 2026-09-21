/**
 * dsh-omp-provider — OMP provider plugin for DeepSeek Harness.
 *
 * Replaces the built-in agent loop with an `AgentFactory` that drives an
 * in-process OMP SDK sidecar (`bun run sidecar/main.ts`, spawned by
 * `OmpSdkClient`) and bridges its event stream into the Dash Agent/Session
 * contracts. There is no `omp --mode rpc` fallback: the legacy RPC client was
 * retired with the SDK migration. Mirrors `@deepseek-ai/dsh-agent-loop`'s creation transaction
 * (prepare → setup → publish) so the session + agent publish as one ordered
 * lifecycle.
 *
 * Phase 3 adds resume:
 *   - `createAgent` records the Dash→OMP session identity in `OmpSessionIndex`
 *     (OMP owns the transcript, Dash owns the live identity).
 *   - `resume` re-attaches the OMP app-home session file through the SDK and restores
 *     the persisted Dash session log (`sessionPersistence.prepare`), so the
 *     Web UI's cold listing/history/follow-up path (`session.list`,
 *     `session.history`, `session.prompt` → `agents.resume`) reopens the
 *     exact transcript it rendered before the restart. The OMP transcript is
 *     replayed (`get_messages`) only when no Dash log was persisted.
 */
import { realpathSync, statSync } from "node:fs";
import { Context, Service } from "@deepseek-ai/cordis";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  Agent,
  AgentFactory,
  AgentHandle,
  AgentOptions,
  AgentSetup,
  CreateAgentOptions,
  ResumeAgentOptions,
} from "@deepseek-ai/dsh-agent";
import { emitAgentEvent } from "@deepseek-ai/dsh-agent";
import type { LlmRuntime } from "@deepseek-ai/dsh-llm";
import { SessionPreparation, SessionLogOffset, type Session, type SessionEvent, type SessionHeader, type SessionId } from "@deepseek-ai/dsh-session";
import type { SessionHandle } from "@deepseek-ai/dsh-session-persistence";
import { OmpSdkClient } from "./sdk-client.js";
import { LazyOmpRpc, type OmpAgentRpc } from "./lazy-rpc.js";
import { OmpAgent } from "./agent.js";
import { OmpLlmAdapter } from "./adapter.js";
import { SingleOmpPresetRoster } from "./agent-preset-omp.js";
import { ompAgentPresetProjection } from "./agent-preset-projection.js";
import { resolveEntryById } from "./pairing.js";
import { cwdFromSessionFile, foreignWriterPid, OMP_SESSIONS_ROOT, parseSelector as parseModelSelector, readOmpDefaultModelFromConfig, sessionHeaderId } from "./omp-store.js";
import { ompModelRoles, ompSetModelRoles } from "./omp-cli.js";
import { loadOmpModels, ompProviderIds, refreshOmpModelsCli } from "./models.js";
import { OMP_NATIVE_HOME, STORAGE_RECONCILE_INTERVAL_MS } from "./knobs.js";
import { defaultPermissionPreset, envApprovalMode, ompApprovalMode, presetFromEvents } from "./permission.js";
import { closeBridgeStore, getBridgeStore, initBridgeStore } from "./store/index.js";
import { prepareIndex, upsertCreated } from "./store/reconcile.js";
import { installMobileBootScript } from "./mobile-boot.js";
import { installOmpDiscovery } from "./discovery.js";

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

/** Diagnostic trace (OMP_TRACE=1 on the dsh process enables stderr tracing). */
const trace = (...parts: unknown[]): void => {
  if (process.env.OMP_TRACE === "1") process.stderr.write(`[omp-provider ${Date.now() % 1_000_000}] ${parts.join(" ")}\n`);
};

/**
 * The slice of `ctx.sessionPersistence` (dsh-session-persistence v2) resume
 * depends on. Typed locally so the plugin needs no dependency surface beyond
 * the handle read: `open(id, "read")` + `handle.read()` restore the durable
 * log — the v2 replacement for the removed `load`/`prepare` pair.
 */
interface SessionPersistenceSlice {
  create(
    header: SessionHeader,
    options?: { inheritedEventCount?: SessionLogOffset; signal?: AbortSignal },
  ): Promise<SessionHandle>;
  open(
    id: SessionId,
    access: "read" | "write",
    options?: { signal?: AbortSignal },
  ): Promise<SessionHandle>;
}

/** Open a read handle, pull the complete stored log, close. */
/** The slice of `ctx.workspaceRegistry` the boot workspace-reconcile reads. */
interface WorkspaceEntitySlice {
  readonly id: string;
  readonly path: string;
  readonly sessionIds: readonly string[];
  attachSession(sessionId: string): Promise<void>;
}
interface WorkspaceRegistrySlice {
  resolveByPath(path: string): Promise<WorkspaceEntitySlice | undefined>;
  create(path: string, title?: string): Promise<WorkspaceEntitySlice>;
  list(): WorkspaceEntitySlice[];
}

export class OmpProvider extends Service implements AgentFactory {
  /**
   * `agentDefaultModel` is load-bearing, not decorative: the harness owns the
   * "default for new sessions" selection there (`@deepseek-ai/dsh-agent-default-model`,
   * mounted by dsh-base with a hard-coded `deepseek-official/deepseek-flash`),
   * and this bridge is the only thing that feeds it OMP's configured default.
   * Without the inject the context cannot resolve the service, every
   * `saveSelection` in #syncModelDefaultTick silently no-ops, and a fresh
   * session inherits the unserved native default → `session/model-unavailable`.
   */
  static inject: string[] = ["agents", "sessions", "llm", "agentDefaultModel", "settings"];

  /** Plain holder — prevents Cordis re-tracing the factory's ctx through a caller shadow. */
  private readonly runtime: { ctx: Context };
  /** Stops the supervisor's follow loop on provider teardown. */
  /** Live RPC-backed agents by dash id, for avoidance hand-off. */
  private readonly heldAgents = new Map<string, AgentHandle>();
  /**
   * Persist the default selection into the settings section.
   *
   * `ctx.agentDefaultModel.saveSelection()` cannot do it: the harness service
   * installs the section from an `inject(["settings"], …)` callback but then
   * writes through `this.ctx.get("settings")?.replace(…)` on its UNSCOPED
   * context, where `settings` is not injected — so the optional chain swallows
   * the lookup and the call is a silent no-op (verified: it returns undefined
   * and the settings file is untouched). We therefore write the installed
   * section directly through our own injected `settings` service; the harness
   * still reads it back through `installSection`'s fold, so behaviour is
   * unchanged for every other consumer.
   */
  async #saveDefaultSelection(selection: { provider: string; model: string }): Promise<void> {
    const settings = this.runtime.ctx.get("settings") as
      | { replace?: (namespace: string, value: unknown) => Promise<unknown> }
      | undefined;
    await settings?.replace?.("agent-default-model", {
      provider: selection.provider,
      model: selection.model,
    });
  }

  /** Shadow of OMP's `modelRoles.default` (`provider/model`) seen last tick. */
  #ompDefaultKey = "";
  /** Shadow of DSH's agentDefaultModel selection (`provider/model`) seen last tick. */
  #dshSelectionKey = "";

  constructor(ctx: Context) {
    super(ctx, "ompProvider");
    this.runtime = { ctx };
    ctx.effect(() => ctx.agents.setFactory(this), "ompProvider.setFactory()");
    // Native-home ruling (2026-09-17): the sidecar/SDK runs on the operator's
    // native OMP home (`~/.omp`; $OMP_HOME overrides in tests) — no app-home
    // bootstrap, no config seeding. The world DSH home only holds DSH state.
    this.#registerModelCatalog();
    // Boot the centralized index BEFORE any service reads session state: warm
    // pass + migration, so the first landing sees real titles/models (D5.1).
    initBridgeStore();
    void this.#syncModelDefaultTick();
    // dsh-shape-session-log: the native jsonl backend (re-enabled in the patch)
    // is the sole `sessionPersistence` — the plugin no longer provides a union
    // persistence. Session list/page/replay come from native components; omp-web
    // is only the producer (writes the dsh session log on live turns).
    // The roster must be visible to the API gateway's root-level remote
    // enumeration (dsh-host-apiproxy read it from the root service table);
    // nesting it under a child fiber via ctx.plugin hides its @Remote routes
    // from the gateway and every agentPresets/* call 404s. Register it on
    // this plugin's own (top-level) fiber instead — its Service constructor
    // ties teardown to this fiber via reflect.provide.
    new SingleOmpPresetRoster(ctx);
    // Drive the `agentPreset` session projection ourselves: the upstream
    // registrant lives in the (disabled) dsh-agent-presets package, but the
    // Web UI gates the preset chip and header label on
    // `projectionValues.agentPreset`. Deferred via inject so the registry's
    // service contract is honored (registers only once it exists).
    ctx.inject(["sessionProjections"], (scoped: Context) => {
      scoped.sessionProjections.register(ompAgentPresetProjection);
    });
    ctx.effect(() => () => closeBridgeStore(), "ompProvider.storeClose()");
    this.#reconcileWorkspaces();
    // Mobile page-config boot script (host half): sets `window.__OMP_WEB_MOBILE__`
    // + the iOS zoom-guard section. Fail-open — a missing webServer leaves the
    // feature dormant, and an injection failure is logged, never thrown.
    installMobileBootScript(ctx);
    // OMP skills + slash commands into the host's `skills`/`commands` seams.
    installOmpDiscovery(ctx);
  }

  /**
   * Two-way default-model sync, evaluated once per reconcile tick (and once
   * at boot): OMP's `modelRoles.default` (CLI) ↔ DSH's `agentDefaultModel`
   * selection. TUI semantics on both sides — a default write survives
   * sessions. Direction is decided by shadow keys: whichever side moved
   * since the last tick wins, and an echo (same value round-tripping back)
   * is a no-op.
   */
  async #syncModelDefaultTick(): Promise<void> {
    const service = this.runtime.ctx.get("agentDefaultModel") as
      | {
          currentSelection?: () => { provider: string; model: string };
          saveSelection?: (selection: { provider: string; model: string }) => Promise<unknown>;
        }
      | undefined;
    // Source of truth is OMP's config.yml ON DISK, never the sidecar: the
    // sidecar is cold at boot and this tick must publish OMP's default to
    // `ctx.agentDefaultModel` immediately (archived default-model contract).
    const ompParsed = readOmpDefaultModelFromConfig();
    const ompKey = ompParsed === undefined ? undefined : `${ompParsed.provider}/${ompParsed.model}`;
    const dsh = service?.currentSelection?.();
    const dshKey = dsh === undefined ? undefined : `${dsh.provider}/${dsh.model}`;
    try {
      if (ompKey !== undefined && ompKey !== this.#ompDefaultKey) {
        // OMP side moved (TUI default switch or config edit): carry it into
        // the store and the DSH default so new Web sessions inherit it.
        this.#ompDefaultKey = ompKey;
        if (ompParsed !== undefined) {
          getBridgeStore()?.setOmpDefaultModel(ompParsed.provider, ompParsed.model);
          await this.#saveDefaultSelection(ompParsed);
          this.#dshSelectionKey = ompKey;
          this.runtime.ctx.logger.info(`omp-provider: default model ← OMP: ${ompKey}`);
        }
      } else if (dshKey !== undefined && dshKey !== this.#dshSelectionKey) {
        // DSH side moved (Web UI selector switch): propagate into OMP's
        // modelRoles.default through the CLI so TUI sessions inherit it.
        this.#dshSelectionKey = dshKey;
        if (dsh !== undefined && dshKey !== this.#ompDefaultKey) {
          // Guard: never write a selection OMP cannot serve into the operator's
          // native config (e.g. dash's built-in `deepseek-official`, which no
          // adapter serves) — that would poison `~/.omp/agent/config.yml`.
          const served = loadOmpModels().some(
            (candidate) => candidate.provider === dsh.provider && candidate.id === dsh.model,
          );
          if (!served) {
            this.runtime.ctx.logger.warn(`omp-provider: refusing to write an unserved selection → OMP: ${dshKey}`);
            return;
          }
          const next = { ...((await ompModelRoles()) ?? {}), default: `${dsh.provider}/${dsh.model}` };
          if (await ompSetModelRoles(next)) {
            this.#ompDefaultKey = dshKey;
            this.runtime.ctx.logger.info(`omp-provider: default model → OMP: ${dshKey}`);
          } else {
            this.runtime.ctx.logger.warn(`omp-provider: default model → OMP write failed: ${dshKey}`);
          }
        }
      }
    } catch (error) {
      this.runtime.ctx.logger.warn(`omp-provider: default model sync failed: ${String(error)}`);
    }
  }


  /**
   * Reconcile the Web UI workspace sidebar against the scanned OMP store.
   *
   * The upstream workspace registry (`dsh-workspace`) only auto-groups by cwd
   * on its FIRST boot (`bootstrap`); every session appearing later is grouped
   * solely by `workspace.attachSession`, which the apiproxy calls only during
   * `create`. TUI-born OMP sessions never pass through `create`, so without
   * this pass they land in the "Ungrouped" bucket even though their cwd is
   * durable in the transcript. Attach each scanned session by its DASH-facing
   * id (dev_0.0.3 §11: OMP ids never cross the bridge boundary) to the
   * workspace owning its canonical cwd — idempotent, fail-soft, every boot.
   */
  #reconcileWorkspaces(): void {
    this.runtime.ctx.inject(["workspaceRegistry"], (wctx) => {
      const registry = wctx.get("workspaceRegistry") as WorkspaceRegistrySlice | undefined;
      if (registry === undefined) return;
      const run = (): void => {
        const store = getBridgeStore();
        if (store !== undefined) prepareIndex(store);
        void this.#syncModelDefaultTick();
        void refreshOmpModelsCli();
        void this.#attachScannedSessions(registry);
      };
      run();
      // The registry groups by cwd only at ITS boot, so TUI-side sessions
      // created later (the store gains files at any time) would sit in
      // "Ungrouped" forever. Re-attach periodically: idempotent, fail-soft,
      // and the scan is a stat pass over the store.
      const timer = setInterval(run, STORAGE_RECONCILE_INTERVAL_MS);
      timer.unref();
      wctx.effect(() => () => clearInterval(timer), "ompProvider.reconcileTimer()");
    });
  }

  /** One idempotent attach pass: every scanned session joins the workspace owning its canonical cwd. */
  async #attachScannedSessions(registry: WorkspaceRegistrySlice): Promise<void> {
    try {
      const excluded = new Set<string>();
      for (const home of [
        OMP_NATIVE_HOME,
        process.env.DSH_HOME ?? join(homedir(), ".omp", "dsh"),
      ]) {
        try {
          excluded.add(realpathSync(home));
        } catch {
          // Unresolvable home: nothing to exclude.
        }
      }
      const groups = new Map<string, string[]>();
      const store = getBridgeStore();
      if (store === undefined) return;
      for (const row of store.list()) {
        const cwd = validatedCwd(row.cwd ?? undefined);
        if (cwd === undefined || excluded.has(cwd)) continue;
        const id = row.dsh_session_id;
        const ids = groups.get(cwd);
        if (ids === undefined) groups.set(cwd, [id]);
        else if (!ids.includes(id)) ids.push(id);
      }
      for (const [path, ids] of groups) {
        const workspace = (await registry.resolveByPath(path)) ?? (await registry.create(path));
        for (const id of ids) {
          if (!workspace.sessionIds.includes(id)) await workspace.attachSession(id);
        }
      }
    } catch (error) {
      this.runtime.ctx.logger.warn(`omp-provider: workspace reconciliation failed: ${String(error)}`);
    }
  }

  /**
   * Register the OMP-backed LLM adapter so the browser model selector (an RPC
   * round-trip through the apiproxy reading `ctx.llm.*`) advertises OMP's real
   * providers and models. The registration is tied to the LLM runtime's own
   * lifecycle, mirroring `llm-deepseek`/`llm-pi-ai` (which the profile disables).
   */
  #registerModelCatalog(): void {
    const llm = this.runtime.ctx.get("llm") as LlmRuntime | undefined;
    if (llm === undefined) return;
    const providers = ompProviderIds();
    if (providers.length === 0) {
      this.runtime.ctx.logger.warn("omp-provider: no OMP models discovered; the model selector will be empty");
      return;
    }
    llm.registerAdapter(providers, new OmpLlmAdapter());
  }

  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    const loopCtx = this.runtime.ctx;
    const id = options.sessionId;
    const meta = options.meta ?? {};
    const cwd = meta.cwd;

    // Fork (the apiproxy's `session.fork`) seeds a copied-turn prefix but OMP
    // has no native fork: the child spawned below would start with an EMPTY
    // context while the UI renders the copied history, and after a restart
    // even that history would vanish (OMP's transcript holds only post-fork
    // traffic). Fail the fork cleanly at the factory boundary instead of
    // splitting the two surfaces. `parentSession` in create metadata is set
    // only by the fork path (subagents go through ctx.subagents instead).
    if (meta.parentSession !== undefined) {
      throw new Error(
        `cannot fork session "${meta.parentSession}" onto the OMP provider: OMP has no native session fork`,
      );
    }

    // Approval policy is pinned at OMP launch and the Dash session does not
    // exist yet at this point (it is prepared + announced — which is what
    // stamps `permission/preset` via pinInitialPermission — only inside
    // setupAndPublish, AFTER this spawn), so the effective preset cannot
    // come from session events: read the permission service's default and
    // map it onto the launch flag. OMP_APPROVAL_MODE (headless runs) wins.
    const envMode = envApprovalMode();
    const preset = defaultPermissionPreset(loopCtx);
    const approvalMode = envMode ?? ompApprovalMode(preset);
    trace(`create id=${id} preset=${preset ?? "none"} approval-mode=${approvalMode}${envMode === undefined ? "" : " (env override)"}`);

    // Backend takes ZERO part in the UI's browser-local new-session draft:
    // no OMP child, no transcript, no index row, no session events — the
    // session announces blank, exactly like the native agent-loop factory's
    // in-process agent. The child materializes on the first prompt
    // (LazyOmpRpc); adoptSpawnedChild writes the index row and the
    // supervisor's held baseline at that moment, so a draft abandoned before
    // the first prompt costs and leaves NOTHING server-side.
    const rpc = new LazyOmpRpc(["--approval-mode", approvalMode], cwd);
    const preparation = SessionPreparation.create(loopCtx.sessions.prepare(id, {
      ...(options.seed === undefined ? {} : { seed: options.seed }),
      ...(meta === undefined ? {} : { meta }),
    }));
    // The prepared header is the single source of truth for the row the
    // first-spawn adoption writes: v2 folds header identity across
    // live/listed/loaded observations, so created_at/cwd must be copied from
    // it verbatim (an independent Date.now() would SOURCE_CONFLICT the id).
    const header = preparation.session.header;
    // dsh-shape-session-log (producer role): open the native dsh session log
    // write handle now. The jsonl backend routes live `session/event` appends
    // into this handle by session id; we own the handle and close it on teardown
    // (mirrors agent-loop's createStoredSession).
    const persistence = loopCtx.get("sessionPersistence") as SessionPersistenceSlice | undefined;
    const stored = persistence === undefined
      ? undefined
      : { handle: await persistence.create(header, { inheritedEventCount: preparation.session.inheritedEventCount }) };
    rpc.onSpawned((client) => {
      void adoptSpawnedChild(id, header, client, preset);
    });

    // Nothing can fail from the child here (none exists yet); the publish
    // transaction below unwinds its own half-published state on failure — its
    // catch calls rpc.close(), a no-op until the first prompt spawns.
    const handle = await setupAndPublish(loopCtx, ownerCtx, id, options.agentOptions ?? {}, options.setup, preparation.session, rpc, options.parentAgent, "startup", { enterSession: true, preparation, stored });
    return this.registerHeld(id, "", handle);
  }

  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    const loopCtx = this.runtime.ctx;
    const id = options.resumeSessionId;
    // dsh-shape-session-log (dual storage): the dsh session log is the replay
    // of record; the OMP app-home session file is the live runtime's OWN
    // context. Resume opens BOTH — never feed the old dsh transcript back to
    // OMP: OMP re-opens its own file and only receives the NEW user prompt.
    const persistence = loopCtx.get("sessionPersistence") as SessionPersistenceSlice | undefined;
    if (persistence === undefined) {
      throw new Error(`cannot resume session "${id}": session persistence is not configured`);
    }

    // dsh side: take write ownership of the dsh log and read its full seed.
    const sig = options.signal === undefined ? undefined : { signal: options.signal };
    let stored: SessionHandle;
    let coldRead: Awaited<ReturnType<SessionHandle["read"]>>;
    try {
      stored = await persistence.open(id, "write", sig);
      coldRead = await stored.read(0, undefined, sig);
    } catch (error) {
      throw new Error(`cannot resume session "${id}": dsh session log is unreadable (${String(error)})`);
    }

    // OMP side: locate the app-home session file via the bridge-store pairing
    // recorded at first spawn (adoptSpawnedChild stores the SDK-reported file).
    // A BLANK draft has no OMP counterpart and no context to resume: the host
    // resumes any persisted id (createOrAdopt), and the UI's new-chat persists
    // an empty session first — so start a FRESH OMP session for it instead of
    // failing. A session with real content has no OMP context we may feed the
    // runtime (never replay the dsh transcript into OMP): fail loudly.
    const record = resolveEntryById(id);
    trace(`resume id=${id} record=${record === undefined ? "MISSING" : record.ompSessionFile}`);
    const hasContent = coldRead.events.some((event) => event.type === "turn/start" || event.type === "user/message" || event.type === "assistant/message");
    if (record === undefined && hasContent) {
      throw new Error(`cannot resume session "${id}": no OMP session is recorded for this Dash session id`);
    }
    const freshOmp = record === undefined;
    const ompFile = record?.ompSessionFile;
    const spawnCwd = validatedCwd(record?.cwd) ?? validatedCwd(stored.header.cwd);

    // Approval mode: persisted permission preset from the dsh log seed
    // (synthesized at create), falling back to the bridge-store row.
    const envMode = envApprovalMode();
    const preset =
      getBridgeStore()?.byDshId(String(id))?.permission_preset ??
      presetFromEvents([...coldRead.events]);
    const approvalMode = envMode ?? ompApprovalMode(preset);
    trace(`resume id=${id} preset=${preset ?? "none"} approval-mode=${approvalMode}${envMode === undefined ? "" : " (env override)"}${freshOmp ? " fresh-omp" : ""}`);

    // OMP live runtime — ALWAYS LAZY (sidecar-decoupling ruling, both branches).
    // Opening/replaying a persisted session in the WebUI promotes it through
    // history.follow → resume; a read-only visit must NOT materialize the OMP
    // child. `LazyOmpRpc` spawns on the FIRST dispatch (prompt/followUp/steer/
    // ensureStarted in #startTurn); passive queries synthesize without a child.
    // Blank draft: no app-home file exists yet — the child adopts a fresh OMP
    // session on first prompt (adoptSpawnedChild then writes the mapping).
    // With content: the child re-attaches its OWN app-home file via --resume
    // (never the dsh transcript); the mapping already exists in the bridge
    // store, so no adoption hook is needed.
    let rpc: OmpAgentRpc;
    if (ompFile === undefined) {
      const lazy = new LazyOmpRpc(["--approval-mode", approvalMode], spawnCwd);
      lazy.onSpawned((client) => { void adoptSpawnedChild(id, stored.header, client, preset); });
      rpc = lazy;
    } else {
      rpc = new LazyOmpRpc(["--approval-mode", approvalMode, "--resume", ompFile], spawnCwd);
    }

    try {
      // Fresh attach: seed the dsh session from the dsh log (native replay),
      // header identity folded from the stored header verbatim.
      const preparation = SessionPreparation.create(
        loopCtx.sessions.prepare(id, {
          seed: [...coldRead.events],
          meta: structuredClone(stored.header),
          inheritedEventCount: stored.inheritedEventCount,
          eventState: coldRead.eventState,
        }),
      );
      trace(`resume id=${id} seeded from dsh session log (${coldRead.events.length} events)`);
      const handle = await setupAndPublish(loopCtx, ownerCtx, id, options.agentOptions ?? {}, options.setup, preparation.session, rpc, options.parentAgent, "resume", { enterSession: true, preparation, stored: { handle: stored, written: coldRead.events.length } });
      return this.registerHeld(id, ompFile ?? "", handle);
    } catch (error) {
      trace(`resume ${id} THREW: ${String(error)} | stack=${error instanceof Error ? error.stack?.slice(0, 400) : "n/a"}`);
      await stored.close().catch(() => {});
      rpc.close();
      throw error;
    }
  }
  /**
   * Track a published RPC-backed agent and hand the session to the supervisor
   * as held. Arrow FIELD (not a `#` method): the provider is exposed through
   * a Cordis tracing proxy, and hard-private methods fail their brand check
   * on the proxy receiver (the same reason setupAndPublish is module-level).
   */
  private readonly registerHeld = (id: SessionId, file: string, handle: AgentHandle): AgentHandle => {
    const wrapped: AgentHandle = {
      agent: handle.agent,
      dispose: async () => {
        this.heldAgents.delete(String(id));
        await handle.dispose();
      },
    };
    this.heldAgents.set(String(id), wrapped);
    return wrapped;
  };


}

/**
 * Shared creation/resume transaction: build the agent over the prepared
 * session, run unpublished setup, and publish both in order. Kept as a
 * module-level function (not a private method) because Cordis exposes the
 * provider through a tracing proxy, which breaks hard-private (`#`) receivers.
 */
/**
 * First-spawn adoption for a lazily created session: the OMP child exists only
 * from the first prompt on, so the bridge index row and the supervisor's held
 * baseline are written HERE instead of at create time. The row copies the
 * prepared header's created_at/cwd verbatim — v2 folds header identity across
 * live/listed/loaded observations, and an independent timestamp would make
 * session/query throw SOURCE_CONFLICT for the id. Fail-soft: an adoption
 * failure degrades that session's metadata (the next reconcile pass retries
 * against the transcript), never the prompt itself.
 */
async function adoptSpawnedChild(
  id: SessionId,
  header: SessionHeader,
  client: OmpSdkClient,
  preset: string | undefined,
): Promise<void> {
  try {
    const state = await client.getState();
    const file = state.sessionFile;
    if (file === undefined || file === "") return;
    const store = getBridgeStore();
    const ompId = state.sessionId ?? sessionHeaderId(file);
    if (store !== undefined && ompId !== undefined) {
      upsertCreated(store, {
        ompSessionId: ompId,
        sessionFile: file,
        dshSessionId: String(id),
        createdAt: header.createdAt,
        cwd: header.cwd,
        ...(preset === undefined ? {} : { preset }),
      });
    }
    trace(`adoptSpawnedChild id=${id} file=${file}`);
  } catch (error) {
    trace(`adoptSpawnedChild id=${id} failed: ${String(error)}`);
  }
}

async function setupAndPublish(
  loopCtx: Context,
  ownerCtx: Context,
  id: SessionId,
  agentOptions: AgentOptions,
  setup: AgentSetup | undefined,
  session: Session,
  rpc: OmpAgentRpc,
  parentAgent: Agent | undefined,
  source: "startup" | "resume",
  opts: { enterSession: boolean; preparation?: SessionPreparation; stored?: { handle: SessionHandle; written?: number } },
): Promise<AgentHandle> {
  let detachSession: (() => void) | undefined;
  let detachAgent: (() => void) | undefined;
  let agent: OmpAgent | undefined;
  // Late-bound teardown the agent triggers itself after its idle window
  // expires (see OmpAgent's idle exit) — defined only after publication.
  let idleExit: (() => void) | undefined;
  try {
    // Build the agent shim over the session and the live RPC client. For a
    // promoted shadow the session is already entered+announced; enterSession
    // is false and the projection is reused (seq-continuous promotion).
    agent = new OmpAgent(loopCtx, id, agentOptions, session, rpc, () => idleExit?.());

    // The live system prompt is NOT stamped here anymore: the eager append
    // turned the UI's new-session draft into a non-blank session and broke
    // the composer. It is committed on the first turn by OmpAgent's
    // #bootstrapSessionIdentity, after the lazy child spawns — surface node 0
    // ahead of turn/start, the native loop's step() ordering. A replayed or
    // resumed session seeds its own system/message from the transcript.

    // Composition-only setup on the unpublished agent scope.
    const commit = await setup?.(agent.ctx, agent);

    // Publish: enter both session and agent, announce in order, then signal
    // session-start. The commit runs immediately before publication.
    commit?.commit();

    // dsh-shape-session-log (producer role): flush events appended BEFORE
    // publication that never emit through `session/event` (constructor seeds
    // and the restore path's `session/end-seed`). Without this the jsonl
    // writer would see a gap (expected N, got N+1) and halt the drain.
    // Mirrors agent-loop's `appendUnstoredSuffix`.
    if (opts.stored !== undefined) {
      const written = opts.stored.written ?? 0;
      const suffix = session.snapshotEvents(SessionLogOffset(written));
      if (suffix.length > 0) await opts.stored.handle.append(suffix);
      opts.stored.written = written + suffix.length;
    }

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
      trace(`dispose() called for agent ${id} (source=${source}) stack=${new Error().stack?.split("\n").slice(1, 4).join(" <- ")}`);
      unfollowOwner?.();
      await agent?.dispose();
      await opts.stored?.handle.close().catch(() => {});
      detachAgent?.();
      detachSession?.();
    };
    idleExit = () => void dispose();

    // Follow the owner: a caller-fiber unload tears this agent down.
    unfollowOwner = ownerCtx.effect(() => () => {
      void dispose();
    }, `ompProvider.lifecycle(${id})`);

    return { agent, dispose };
  } catch (error) {
    // Unwind the half-published transaction. A failure between `enter` and
    // the announcements (e.g. a persistence listener rejecting the session)
    // must not leave a live-but-dead entry the API resolver would serve.
    trace(`setupAndPublish ${id} FAILED: ${String(error)}`);
    detachAgent?.();
    detachSession?.();
    void agent?.dispose().catch(() => {});
    rpc.close();
    throw error;
  } finally {
    // Release the preparation's per-id reservation on every path (mirrors
    // the reference loop's unconditional dispose): the session it seeded is
    // already published above, so a same-process re-resume of this id can
    // prepare again instead of colliding with a leaked reservation. Promotion
    // has no preparation (the shadow's projection persists across the call).
    opts.preparation?.[Symbol.dispose]();
  }
}

export default OmpProvider;
