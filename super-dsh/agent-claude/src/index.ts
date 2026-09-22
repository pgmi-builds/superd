/**
 * agent-claude provider — Claude Code provider plugin for DeepSeek Harness
 * (Agent Worlds, standalone SDK line).
 *
 * Replaces the built-in agent loop with an `AgentFactory` that drives one
 * `ClaudeSdkClient` (a per-session Claude Agent SDK bridge) and bridges the
 * projected wire stream into the Dash Agent/Session contracts. Mirrors
 * `@deepseek-ai/dsh-agent-loop`'s creation transaction (prepare → owned
 * storage handle → setup → publish) so the session + agent publish as one
 * ordered lifecycle AND the DSH session log is written through the upstream
 * `sessionPersistence` service — list/read/replay/workspace grouping are then
 * ordinary DSH services over that log.
 *
 * Session identity (route A, "mapping only"): the Claude session id is derived
 * deterministically from the DSH id's UUID tail (`claudeSessionIdFromDsh`), so
 * the id itself survives restarts with no map. The effective Claude permission
 * mode cannot round-trip through the event log (extra tiers are skipped by
 * `presetFromEvents`), so it is persisted at the world DSH-home root alongside
 * the `claudeSessionId` (`<worldHome>/dsh-sessions.json`, see session-map.ts)
 * and re-applied on resume via `client.setPermissionMode(mode)`.
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
import type { LlmRuntime } from "@deepseek-ai/dsh-llm";
import {
  SessionLogOffset,
  SessionPreparation,
  interruptedTurnClosers,
  type Session,
  type SessionId,
} from "@deepseek-ai/dsh-session";
import type { SessionHandle, SessionPersistence } from "@deepseek-ai/dsh-session-persistence";
import { ClaudeSdkClient, probeClaudeModels } from "./claude-client.js";
// Type-only: pulls the `ctx.sessionProjections` Context augmentation into this unit.
import type { } from "@deepseek-ai/dsh-session-projection";
import { ClaudeAgent, type ClaudeAgentRuntimeInfo } from "./agent.js";
import { ClaudeLlmAdapter, CLAUDE_PROVIDER_ID } from "./adapter.js";
import { resolveClaudeHome } from "./claude-home.js";
import { resetProjectionState } from "./claude-events.js";
import { claudeSessionIdFromDsh } from "./session-id.js";
import {
  claudePermissionMode,
  defaultPermissionPreset,
  modeChangePatch,
  presetFromEvents,
  type ClaudePermissionMode,
} from "./permission.js";
import { sessionRecord, upsertSession } from "./session-map.js";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import {
  makeCanUseTool,
  answerAskUserQuestion,
  askPlanReview,
  type ApprovalLike,
  type UserQuestionsLike,
  type PermissionDecision,
} from "./interaction.js";
import { modelEntryFromSdk, readModelCatalog, setModelCatalog, CLAUDE_DEFAULT_MODEL } from "./models.js";
import { SingleClaudePresetRoster } from "./agent-preset-claude.js";
import { claudeAgentPresetProjection } from "./agent-preset-projection.js";

const CLAUDE_MODES: readonly string[] = ["default", "acceptEdits", "bypassPermissions", "plan", "auto", "dontAsk"];

/** Narrow an untrusted value to a persisted Claude permission mode. */
function isClaudeMode(raw: unknown): raw is ClaudePermissionMode {
  return typeof raw === "string" && CLAUDE_MODES.includes(raw);
}

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

/** Diagnostic trace (CLAUDE_TRACE=1 on the dsh process enables stderr tracing). */
const trace = (...parts: unknown[]): void => {
  if (process.env.CLAUDE_TRACE === "1") process.stderr.write(`[claude-provider ${Date.now() % 1_000_000}] ${parts.join(" ")}\n`);
};

/**
 * Resume identity guard (exported for unit testing): fail closed when no Claude
 * session is recorded for the DSH session id. Route B (a mapping file) is V1+
 * work, so a missing/empty id is a genuine unknown, never a silent new session.
 */
export function resumeGuard(record: { dshSessionId: string; claudeSessionId: string | null | undefined }): void {
  if (typeof record.claudeSessionId !== "string" || record.claudeSessionId === "") {
    throw new Error(`cannot resume session "${record.dshSessionId}": no Claude session is recorded for this Dash session id`);
  }
}

/**
 * The host-side `canUseTool` dispatcher the provider injects into the SDK
 * options. Claude Code routes every human permission decision through exactly
 * three channels — the `AskUserQuestion` tool, `ExitPlanMode` (plan review),
 * and every other tool's permission gate — and this dispatcher fans each onto
 * the DSH native seams. A missing seam fails CLOSED (deny), never silently
 * lets the CLI decide. Approvals are wrapped in the agent's `runApproval` so
 * the idle-TTL gate protects a session waiting on a human.
 */
export function makeClaudeCanUseTool(deps: {
  approval: ApprovalLike | undefined;
  questions: UserQuestionsLike | undefined;
  getAgent: () => ClaudeAgent | undefined;
}): CanUseTool {
  return async (toolName, input, options) => {
    const agent = deps.getAgent();
    const approval = deps.approval;
    const questions = deps.questions;
    const run = <T>(task: () => Promise<T>): Promise<T> => (agent === undefined ? task() : agent.runApproval(task));
    const deny = (message: string): PermissionDecision => ({ behavior: "deny", message });
    if (toolName === "AskUserQuestion") {
      if (questions === undefined) return deny("Claude Code AskUserQuestion denied (no user-questions seam)");
      return run(() => answerAskUserQuestion({ questions, agent }, input, options.signal));
    }
    if (toolName === "ExitPlanMode") {
      if (questions === undefined) return deny("Claude Code ExitPlanMode denied (no user-questions seam)");
      const plan = input !== null && typeof input === "object"
        ? (input as { plan?: unknown }).plan
        : undefined;
      if (typeof plan !== "string" || plan.trim() === "") {
        // Fail CLOSED on malformed input: dereferencing a null plan here used
        // to reject, which the SDK reads as a denial but reports as noise.
        return deny("Claude Code ExitPlanMode denied (malformed input: no plan)");
      }
      const approved = await run(async () => askPlanReview({ questions, agent }, plan, options.signal));
      return approved ? { behavior: "allow" } : deny("Claude Code ExitPlanMode denied (plan not approved)");
    }
    if (approval === undefined) return deny("Claude Code tool call denied (no approval seam)");
    return run(() => makeCanUseTool({ approval, agent })(toolName, input, {
      toolUseID: options.toolUseID,
      signal: options.signal,
      ...(options.decisionReason === undefined ? {} : { decisionReason: options.decisionReason }),
    }));
  };
}


/** An owned write handle plus the count of events already stored through it. */
interface StoredSession {
  readonly handle: SessionHandle;
  storedCount: number;
}

export class ClaudeProvider extends Service implements AgentFactory {
  static inject: string[] = ["agents", "sessions", "llm", "agentDefaultModel", "settings"];

  /** Plain holder — prevents Cordis re-tracing the factory's ctx through a caller shadow. */
  private readonly runtime: { ctx: Context };
  /** The world's DSH home — from the world's own `dshHomePath`, never ambient env inside plugins. Anchors adapter-owned DSH state (the session map) only; the Claude app home is the CLI's native `~/.claude` (2026-09-17 ruling). */
  private readonly home: string;
  /** Echo/staleness guard for the app-wide default-model push. */
  private defaultModelKey = "";
  constructor(ctx: Context) {
    super(ctx, "claudeProvider");
    this.runtime = { ctx };
    this.home = this.#resolveHome();
    // Native-home ruling (2026-09-17): no CLAUDE_CONFIG_DIR injection — the CLI
    // keeps its native home; this.home only anchors the DSH-side session map.
    trace(`home: worldHome=${this.home} claudeHome=${resolveClaudeHome()}`);
    ctx.effect(() => ctx.agents.setFactory(this), "claudeProvider.setFactory()");
    this.#registerModelCatalog();
    // The roster must be visible to the API gateway's root-level remote
    // enumeration; nesting it under a child fiber via ctx.plugin hides its
    // @Remote routes from the gateway and every agentPresets/* call 404s (the
    // omp/pi registration lesson). Register it on this plugin's own
    // (top-level) fiber instead — next to setFactory, never under ctx.plugin.
    new SingleClaudePresetRoster(ctx);
    // Drive the `agentPreset` session projection ourselves: the upstream
    // registrant lives in the (patch-disabled) dsh-agent-presets package, but
    // the Web UI gates the preset chip and header label on
    // `projectionValues.agentPreset`.
    ctx.inject(["sessionProjections"], (scoped: Context) => {
      scoped.sessionProjections.register(claudeAgentPresetProjection);
    });
    this.#registerDefaultModel();
    this.#probeBootModels();
  }

  /**
   * RC-3 boot model probe: ONE ephemeral SDK query asks the CLI's
   * `supportedModels()` right after the adapter registration, and the answer
   * OVERWRITES the sonnet-only boot catalog (setModelCatalog semantics).
   * Fire-and-forget: a slow/failing probe never delays boot and never
   * touches the boot catalog — `sonnet` (a real CLI alias) stays the
   * probe-failure fallback, and a live session re-observes anyway.
   */
  #probeBootModels(): void {
    void probeClaudeModels()
      .then((models) => {
        const entries = models.flatMap((model) => modelEntryFromSdk(model));
        if (entries.length === 0) {
          trace("boot model probe: the CLI reported no models — boot catalog (sonnet) kept");
          return;
        }
        setModelCatalog(entries, CLAUDE_DEFAULT_MODEL);
        this.runtime.ctx.logger.info(`claude-provider: boot model probe ← ${entries.length} CLI model(s), default ${CLAUDE_DEFAULT_MODEL}`);
      })
      .catch((error) => {
        trace(`boot model probe failed (${String(error)}) — boot catalog (sonnet) kept`);
      });
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
   * The write path is mandatory (2026-09-16): this factory owns the DSH
   * session log through the upstream persistence service — a session created
   * or resumed without a backend would persist nothing.
   */
  private requirePersistence(op: "create" | "resume"): SessionPersistence {
    const persistence = this.runtime.ctx.get("sessionPersistence") as SessionPersistence | undefined;
    if (persistence === undefined) {
      throw new Error(`cannot ${op} a Claude session: session persistence is not configured`);
    }
    return persistence;
  }

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

  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    const loopCtx = this.runtime.ctx;
    const id = options.sessionId;
    const meta = options.meta ?? {};
    const cwd = meta.cwd;

    // Fork is rejected in V1 (the SDK has `forkSession`, but it is not wired).
    if (meta.parentSession !== undefined) {
      throw new Error(`cannot fork session "${meta.parentSession}": fork is not wired in V1`);
    }

    // Route A: derive the Claude session id before anything is spawned.
    const claudeSessionId = claudeSessionIdFromDsh(String(id));
    if (claudeSessionId === undefined) {
      trace(`create ${id}: DSH id carries no UUID and no mapping exists — route B is not wired in V1`);
      throw new Error(`cannot create session "${id}": the Dash session id carries no UUID and route B is not wired in V1`);
    }

    const persistence = this.requirePersistence("create");

    // Single-source permission resolution: one preset → one Claude mode, which
    // is persisted in the session record AND handed to the agent (so the
    // `permission/preset` stamp and the `setPermissionMode` call never diverge).
    const preset = defaultPermissionPreset(loopCtx);
    const claudeMode = claudePermissionMode(preset);
    const spawnCwd = validatedCwd(cwd) ?? process.cwd();
    trace(`create id=${id} claudeSessionId=${claudeSessionId} preset=${preset ?? "none"} claudeMode=${claudeMode} spawnCwd=${spawnCwd}`);

    // Lazy, zero-IO client construction (the CLI spawns on the first prompt).
    // The host-side permission gate is injected now, closing over the injected
    // approval/questions seams plus a lazy agent holder (set in setupAndPublish).
    const agentRef: { current: ClaudeAgent | undefined } = { current: undefined };
    const client = new ClaudeSdkClient({
      cwd: spawnCwd,
      claudeSessionId,
      canUseTool: makeClaudeCanUseTool({
        approval: loopCtx.get("approval") as ApprovalLike | undefined,
        questions: loopCtx.get("userQuestions") as UserQuestionsLike | undefined,
        getAgent: () => agentRef.current,
      }),
      allowDangerouslySkipPermissions: claudeMode === "bypassPermissions",
    });
    // Apply the resolved boot/observed default to the CLI (mirrors codex's
    // create-time `setModel`); an explicit caller selection is honored by
    // `sessionAgentOptions` at publication.
    const createCatalog = readModelCatalog();
    void client.setModel(createCatalog.defaultModel ?? CLAUDE_DEFAULT_MODEL).catch(() => { });
    const preparation = SessionPreparation.create(loopCtx.sessions.prepare(id, {
      ...(options.seed === undefined ? {} : { seed: options.seed }),
      ...(meta === undefined ? {} : { meta }),
      ...(options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount }),
    }));

    let stored: StoredSession | undefined;
    let handedOff = false;
    try {
      stored = await this.createStoredSession(persistence, preparation.session, options.signal);
      // Identity + permission record BEFORE publication: resume resolves it.
      upsertSession(this.home, String(id), {
        claudeSessionId,
        claudeMode,
        cwd: spawnCwd,
        createdAt: Date.now(),
        preset: preset ?? null,
      });
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
        {
          preset,
          claudeMode,
          onModeChange: (mode) => {
            // Upsert {claudeMode, preset} TOGETHER (RC-5): a skeleton mode
            // names its preset via the inverse table; an extra tier
            // (plan/auto/dontAsk) leaves the recorded preset alone.
            upsertSession(this.home, String(id), modeChangePatch(mode));
            trace(`persisted claudeMode ${mode} for ${id}`);
          },
          onNotResumable: () => {
            // 2026-09-18 ruling: a conversation-not-found failure is terminal
            // for the pairing — mark the record dead; later resumes fail fast.
            upsertSession(this.home, String(id), { resumable: false });
            trace(`marked ${id} not resumable (conversation never materialized)`);
          },
        },
        agentRef,
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

    // Identity (2026-09-16 "mapping only"): the DSH session id resolves
    // through the adapter-owned record. A missing record (or a missing/empty
    // Claude session id) is a genuine unknown: fail closed with the DSH id.
    const record = sessionRecord(this.home, String(id));
    trace(`resume id=${id} record=${record === undefined ? "MISSING" : record.claudeSessionId}`);
    resumeGuard({ dshSessionId: String(id), claudeSessionId: record === undefined ? undefined : record.claudeSessionId });
    if (record === undefined) {
      // Unreachable (resumeGuard threw above) — narrows `record` for TS.
      throw new Error(`cannot resume session "${id}": no Claude session is recorded for this Dash session id`);
    }
    if (record.resumable === false) {
      // 2026-09-18 ruling: the CLI never materialized a conversation under the
      // derived id (e.g. the first turn failed). The session is dead — fail
      // fast with the stable code; never resurrect, never re-wrap content.
      const error = new Error(
        `cannot resume session "${id}": its Claude conversation never materialized (the first exchange failed before the CLI persisted one) — start a new session`,
      ) as Error & { code?: string };
      error.code = "CONVERSATION_NOT_FOUND";
      throw error;
    }
    const claudeSessionId = record.claudeSessionId as string;

    // Spawn cwd comes from the recorded pairing — re-realpath and re-verify so
    // a moved/removed directory cannot aim a resume outside a live path.
    const spawnCwd = validatedCwd(record.cwd);
    if (spawnCwd === undefined) {
      throw new Error(`cannot resume session "${id}": its recorded working directory no longer exists`);
    }

    const persistence = this.requirePersistence("resume");

    // Permission re-mount (RC-5): the LOG FOLD is the preset authority —
    // resolved from the cold events once they are read below. The map's
    // `claudeMode` remains ONLY the mode cache for `setPermissionMode` (extra
    // tiers cannot round-trip through the log); a missing/unknown cache falls
    // back to the default preset's mode until the fold is read — traced,
    // never silent.
    let claudeMode: ClaudePermissionMode;
    if (isClaudeMode(record.claudeMode)) {
      claudeMode = record.claudeMode;
    } else {
      claudeMode = claudePermissionMode(defaultPermissionPreset(loopCtx));
      trace(`resume ${id}: no usable claudeMode recorded (${String(record.claudeMode)}) — falling back to ${claudeMode} until the log fold is read`);
    }
    trace(`resume id=${id} spawnCwd=${spawnCwd} claudeMode=${claudeMode} (preset resolved from the log fold below)`);

    // Re-attach to the Claude session by its id (lazy: the CLI resumes on the
    // first prompt). Re-apply the persisted permission mode up front (buffered
    // until the query exists), and re-inject the host-side permission gate.
    const agentRef: { current: ClaudeAgent | undefined } = { current: undefined };
    const client = new ClaudeSdkClient({
      cwd: spawnCwd,
      resumeSessionId: claudeSessionId,
      canUseTool: makeClaudeCanUseTool({
        approval: loopCtx.get("approval") as ApprovalLike | undefined,
        questions: loopCtx.get("userQuestions") as UserQuestionsLike | undefined,
        getAgent: () => agentRef.current,
      }),
      allowDangerouslySkipPermissions: claudeMode === "bypassPermissions",
    });
    void client.setPermissionMode(claudeMode).catch(() => { });

    let handle: SessionHandle | undefined;
    let stored: StoredSession | undefined;
    let preparation: SessionPreparation | undefined;
    let handedOff = false;
    try {
      // Taking write ownership FIRST excludes a concurrent resume of the same id.
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
      handedOff = true;
      // RC-5: the log fold decides the preset at resume — the map's stale
      // `preset` must never overwrite a blank-window choice already folded
      // into the log. The mode cache stays authoritative for the wire unless
      // it was unusable, in which case the folded preset derives the mode and
      // it is re-applied now that the fold is read.
      const foldedPreset = presetFromEvents(cold.events) ?? defaultPermissionPreset(loopCtx);
      if (!isClaudeMode(record.claudeMode)) {
        claudeMode = claudePermissionMode(foldedPreset);
        void client.setPermissionMode(claudeMode).catch(() => { });
        trace(`resume ${id}: mode cache unusable — log fold preset=${foldedPreset ?? "none"} → claudeMode ${claudeMode} (re-applied)`);
      }
      trace(`resume id=${id} fold preset=${foldedPreset ?? "none"} claudeMode=${claudeMode}`);
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
        {
          // RC-5: the log fold decides the preset at resume — the map's stale
          // `preset` must never overwrite a blank-window choice already folded
          // into the log. The mode cache stays authoritative for the wire
          // unless it was unusable, in which case the folded preset derives it.
          preset: foldedPreset,
          claudeMode,
          onModeChange: (mode) => {
            // Upsert {claudeMode, preset} TOGETHER (RC-5): a skeleton mode
            // names its preset via the inverse table; an extra tier
            // (plan/auto/dontAsk) leaves the recorded preset alone.
            upsertSession(this.home, String(id), modeChangePatch(mode));
            trace(`persisted claudeMode ${mode} for ${id}`);
          },
          onNotResumable: () => {
            // 2026-09-18 ruling: a conversation-not-found failure is terminal
            // for the pairing — mark the record dead; later resumes fail fast.
            upsertSession(this.home, String(id), { resumable: false });
            trace(`marked ${id} not resumable (conversation never materialized)`);
          },
        },
        agentRef,
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

  #registerModelCatalog(): void {
    const llm = this.runtime.ctx.get("llm") as LlmRuntime | undefined;
    if (llm === undefined) return;
    llm.registerAdapter([CLAUDE_PROVIDER_ID], new ClaudeLlmAdapter());
  }

  /**
   * The factory owns its sessions' route (user directive 2026-09-15): the
   * ambient `agentDefaultModel` selection is NOT authoritative here — a session
   * created by this factory always runs on the `claude` route, with the boot
   * default (or an observed default) unless the caller asked for a served
   * claude model.
   */
  private sessionAgentOptions(requested: AgentOptions | undefined): AgentOptions {
    const catalog = readModelCatalog();
    const explicit = requested?.provider === CLAUDE_PROVIDER_ID && typeof requested.model === "string" && requested.model !== ""
      ? requested.model
      : undefined;
    const model = explicit ?? catalog.defaultModel ?? CLAUDE_DEFAULT_MODEL;
    return { ...(requested ?? {}), provider: CLAUDE_PROVIDER_ID, ...(model === undefined ? {} : { model }) };
  }

  /**
   * App-wide default-model push (mirrors `agent-codex` `#registerDefaultModel`
   * faithfully): the harness owns the "default for new sessions" selection in
   * `agentDefaultModel` (mounted by dsh-base with a hard-coded
   * `deepseek-official/deepseek-flash`), and this bridge is the only thing that
   * feeds it a claude-routed default. Without the inject the context cannot
   * resolve the service at apply time and the push never fires. The write goes
   * through `settings.replace` AND `saveSelection` (the double path that avoids
   * the upstream silent no-op) with an echo-guarded `defaultModelKey`.
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
      const catalog = readModelCatalog();
      const target = { provider: CLAUDE_PROVIDER_ID, model: catalog.defaultModel ?? CLAUDE_DEFAULT_MODEL };
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
          this.runtime.ctx.logger.info(`claude-provider: default model ← claude catalog: ${targetKey}`);
        })
        .catch((error) => {
          this.runtime.ctx.logger.warn(`claude-provider: default model save failed: ${String(error)}`);
        });
    });
  }
}

/**
 * Durable flush of the session's pre-publication suffix. Constructor seed
 * markers and setup-window events never re-emit through `session/event`, so
 * publication must push them through the handle before live events start
 * routing into it.
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
 * provider through a tracing proxy, which breaks hard-private receivers.
 */
async function setupAndPublish(
  loopCtx: Context,
  ownerCtx: Context,
  id: SessionId,
  agentOptions: AgentOptions,
  setup: AgentSetup | undefined,
  session: Session,
  client: ClaudeSdkClient,
  parentAgent: Agent | undefined,
  source: "startup" | "resume",
  opts: { enterSession: boolean; preparation?: SessionPreparation },
  stored: StoredSession,
  runtimeInfo: ClaudeAgentRuntimeInfo,
  agentRef: { current: ClaudeAgent | undefined },
): Promise<AgentHandle> {
  let detachSession: (() => void) | undefined;
  let detachAgent: (() => void) | undefined;
  let agent: ClaudeAgent | undefined;
  let idleExit: (() => void) | undefined;
  try {
    // Session-start projection reset lives in the agent constructor; this
    // module-level reset is belt-and-suspenders for a re-entry before the
    // agent exists (e.g. a throwing setup that re-publishes).
    resetProjectionState();
    agent = new ClaudeAgent(loopCtx, id, agentOptions, session, client, () => idleExit?.(), runtimeInfo);
    agentRef.current = agent;

    // Composition-only setup on the unpublished agent scope.
    const commit = await setup?.(agent.ctx, agent);

    // Publish: flush the unstored suffix, enter + announce in order.
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
      await stored.handle.close();
    };
    idleExit = () => {
      void dispose().catch((error) => {
        loopCtx.logger.warn(`claude-provider: teardown of ${id} failed: ${String(error)}`);
      });
    };

    unfollowOwner = ownerCtx.effect(() => () => {
      void dispose().catch((error) => {
        loopCtx.logger.warn(`claude-provider: owner-unload teardown of ${id} failed: ${String(error)}`);
      });
    }, `claudeProvider.lifecycle(${id})`);

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

export default ClaudeProvider;
