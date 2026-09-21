/**
 * CodexSdkClient — the SDK-line client seam (AW-E Task 3).
 *
 * Public surface mirrors `OmpSdkClient` (agent-omp/src/sdk-client.ts) exactly —
 * `spawn` / `on` / `onFailure` / `sendRaw` / `send` / `getState` / `getMessages`
 * / `getSessionStats` / `getSubagents` / `prompt` / `followUp` / `steer` /
 * `setModel` / `abort` / `newSession` / `close` / `ensureStarted` / `spawned` —
 * so the Task 7 agent.ts/index.ts port compiles against this client the way it
 * compiles against the omp one. Instead of one `omp --mode rpc` sidecar per
 * session, ALL clients multiplex ONE module-level refcounted `Codex` instance
 * (same acquire()/release() pattern as the omp sidecar; the SDK spawns its own
 * per-turn codex process, so dropping the shared instance needs no stop call).
 *
 * Codex home: the shared instance is constructed with `{ env: { ...process.env } }`
 * (SDK env is REPLACE semantics — Task 1 spike fact, so the spread is
 * mandatory) and carries NO `CODEX_HOME`: the CLI resolves its own native
 * `~/.codex` (user ruling 2026-09-17 — never redirect the native app home at
 * spawn; tests redirect via `process.env.CODEX_HOME`). The SDK constructor
 * itself is injectable via {@link setCodexFactory}.
 *
 * Wire events flow through `projectThreadEvent` (codex-events.ts) before
 * reaching listeners, so Task 7's agent.ts switch is unchanged from omp.
 */
import { Codex, type CodexOptions } from "@openai/codex-sdk";
import { projectThreadEvent, type WireContentBlock, type WireEvent, type WireMessage } from "./codex-events.js";

// ---------------------------------------------------------------------------
// Structural seams (duck-typed so fakes inject plain objects)
// ---------------------------------------------------------------------------

/** Minimal structural shape of the SDK `Codex` entry object. */
export interface CodexLike {
  startThread(options?: CodexThreadOptions): CodexThreadLike;
  resumeThread(id: string, options?: CodexThreadOptions): CodexThreadLike;
}

/** Minimal structural shape of an SDK `Thread`. */
export interface CodexThreadLike {
  readonly id: string | null;
  runStreamed(input: string, turnOptions?: CodexTurnOptions): Promise<CodexStreamedTurnLike>;
}

export interface CodexTurnOptions {
  signal?: AbortSignal;
}

export interface CodexStreamedTurnLike {
  events: AsyncIterable<unknown>;
}

/** The ThreadOptions subset this client passes (approval policy via the launch-only preset mapping). */
export interface CodexThreadOptions {
  model?: string;
  workingDirectory?: string;
  skipGitRepoCheck?: boolean;
  approvalPolicy?: string;
}

export type CodexFactory = (options: { env: Record<string, string> }) => CodexLike;
let codexFactory: CodexFactory = (options) => new Codex(options as CodexOptions) as unknown as CodexLike;
/** Replace the SDK constructor (tests inject a fake Codex). */
export function setCodexFactory(factory: CodexFactory): void {
  codexFactory = factory;
}

// ---------------------------------------------------------------------------
// Shared Codex instance (module-level singleton, refcounted — omp sidecar pattern)
// ---------------------------------------------------------------------------

let sharedCodex: CodexLike | null = null;
let refcount = 0;

function acquire(): CodexLike {
  if (sharedCodex === null) {
    sharedCodex = codexFactory({ env: { ...process.env } as Record<string, string> });
  }
  refcount += 1;
  return sharedCodex;
}

function release(): void {
  refcount = Math.max(0, refcount - 1);
  if (refcount === 0) sharedCodex = null;
}

/** Test/observability hook: current shared-instance refcount (0 = none alive). */
export function codexClientRefCount(): number {
  return refcount;
}

// ---------------------------------------------------------------------------
// Wire response/state shapes (RpcResponse / OmpState ports, codex-internal names)
// ---------------------------------------------------------------------------

/** Response-shape shim so RpcResponse-typed call sites keep compiling (Task 7). */
export interface WireResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

/** The `get_state`-shaped payload (omp OmpState port, codex-internal name). */
export interface WireState {
  isStreaming: boolean;
}

function ok(command: string): WireResponse {
  return { type: "response", command, success: true };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Parse the omp-style spawn args. `--approval-mode <v>` is accepted and
 * applied verbatim as the thread's launch `approvalPolicy` — the 3-preset
 * mapping resolves the VALUE provider-side (Task 7's permission.ts) and the
 * thread carries it on every construction (start, resume, setModel rebuild).
 * `--resume-thread <id>` constructs the client on `codex.resumeThread(id, …)`
 * — the thread-identity resume (plan Task 7), strictly distinct from the
 * rejected omp-style `--resume <file>`, which keeps failing loudly exactly
 * like unknown args.
 */
function parseSpawnArgs(args: string[]): { approvalMode?: string; resumeThreadId?: string } {
  const out: { approvalMode?: string; resumeThreadId?: string } = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--approval-mode" && args[i + 1] !== undefined) {
      out.approvalMode = args[++i];
    } else if (args[i] === "--resume-thread" && args[i + 1] !== undefined) {
      out.resumeThreadId = args[++i];
    } else {
      throw new Error(`CodexSdkClient: unsupported spawn arg "${String(args[i])}" (SDK line)`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

export class CodexSdkClient {
  readonly #codex: CodexLike;
  readonly #listeners = new Set<(event: WireEvent) => void>();
  readonly #failureListeners = new Set<(error: Error) => void>();
  readonly #threadOptions: CodexThreadOptions;
  readonly #messages: WireMessage[] = [];
  readonly #queue: string[] = [];
  #approvalMode: string | undefined;
  #thread: CodexThreadLike;
  #closed = false;
  #failure: Error | null = null;
  #inFlight = false;
  #currentAbort: AbortController | null = null;
  #currentRun: Promise<void> | null = null;
  #pendingModel: string | null = null;
  #appliedModel: string | null = null;
  #lastUsage: Record<string, unknown> | null = null;
  /** Bumped by newSession()/close() to orphan runs started on an earlier thread. */
  #sessionEpoch = 0;

  private constructor(codex: CodexLike, cwd: string | undefined, approvalMode?: string, resumeThreadId?: string) {
    this.#codex = codex;
    this.#approvalMode = approvalMode;
    // skipGitRepoCheck: adapters spawn from arbitrary test/worktree cwds (Task 1 spike precedent).
    // Launch-only approval mapping (Task 7): present only when the provider
    // resolved a preset, so plain spawns keep the bare ThreadOptions shape.
    this.#threadOptions = {
      workingDirectory: cwd,
      skipGitRepoCheck: true,
      ...(approvalMode === undefined ? {} : { approvalPolicy: approvalMode }),
    };
    // `--resume-thread <id>` re-attaches to the existing Codex thread (the
    // model context lives in Codex's rollout); plain spawn starts a fresh one.
    this.#thread =
      resumeThreadId === undefined ? codex.startThread(this.#threadOptions) : codex.resumeThread(resumeThreadId, this.#threadOptions);
  }

  /**
   * Start a session on the shared Codex instance and resolve once ready.
   * Mirrors `OmpSdkClient.spawn(args, cwd)`.
   */
  static async spawn(args: string[] = [], cwd?: string): Promise<CodexSdkClient> {
    const { approvalMode, resumeThreadId } = parseSpawnArgs(args);
    const codex = acquire();
    try {
      return new CodexSdkClient(codex, cwd, approvalMode, resumeThreadId);
    } catch (error) {
      release();
      throw error;
    }
  }

  /** Register a wire event listener; returns the unsubscriber. */
  on(listener: (event: WireEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Register a failure listener; returns the unsubscriber. */
  onFailure(listener: (error: Error) => void): () => void {
    this.#failureListeners.add(listener);
    return () => {
      this.#failureListeners.delete(listener);
    };
  }

  /**
   * Raw-command escape hatch. The SDK line has no stdio command channel, so
   * RPC-specific records (e.g. `extension_ui_response` approval answers) are
   * accepted and logged under CODEX_TRACE=1 — approval flows route through
   * SDK-side approval work (Task 7 parity item).
   */
  sendRaw(command: Record<string, unknown>): void {
    if (this.#failure !== null || this.#closed) return;
    if (process.env.CODEX_TRACE === "1") {
      process.stderr.write(`[codex-sdk] sendRaw (no-op on SDK line): ${JSON.stringify(command).slice(0, 160)}\n`);
    }
  }

  /** Generic command sender mapping the omp command table onto client methods. */
  async send(command: Record<string, unknown>): Promise<WireResponse> {
    switch (command.type) {
      case "prompt":
        await this.prompt(String(command.message));
        return ok("prompt");
      case "steer":
        await this.steer(String(command.message));
        return ok("steer");
      case "follow_up":
        await this.followUp(String(command.message));
        return ok("follow_up");
      case "abort":
        await this.abort();
        return ok("abort");
      case "set_model":
        await this.setModel(String(command.provider), String(command.modelId));
        return ok("set_model");
      case "new_session":
        await this.newSession();
        return ok("new_session");
      case "get_state":
        return { type: "response", command: "get_state", success: true, data: await this.getState() };
      case "get_messages":
        return { type: "response", command: "get_messages", success: true, data: { messages: await this.getMessages() } };
      default:
        throw new Error(`CodexSdkClient.send: unsupported command "${String(command.type)}" (SDK line)`);
    }
  }

  /** Query session state; returns the `get_state`-shaped payload. */
  async getState(): Promise<WireState> {
    this.#ensureUsable();
    return { isStreaming: this.#inFlight };
  }

  /**
   * Best-effort conversation mirror accumulated from the wire (user echoes at
   * acceptance, assistant message_end, toolResult). The authoritative
   * transcript comes from the rollout scan (codex-store.ts); reasoning-only
   * messages are not mirrored. Fail-soft: [] when nothing accumulated.
   */
  async getMessages(): Promise<WireMessage[]> {
    try {
      return [...this.#messages];
    } catch {
      return [];
    }
  }

  /** Live token accounting from the last turn_end usage (fail-soft {}). */
  async getSessionStats(): Promise<Record<string, unknown>> {
    try {
      const usage = this.#lastUsage;
      if (usage === null) return {};
      const tokens: Record<string, number> = {};
      const map: Array<[string, string]> = [
        ["input", "input_tokens"],
        ["output", "output_tokens"],
        ["cacheRead", "cached_input_tokens"],
        ["cacheWrite", "cache_write_input_tokens"],
      ];
      for (const [wireKey, codexKey] of map) {
        const value = usage[codexKey];
        if (typeof value === "number") tokens[wireKey] = value;
      }
      return { tokens };
    } catch {
      return {};
    }
  }

  /** Codex has no subagent registry (fail-soft constant, omp surface parity). */
  async getSubagents(): Promise<unknown[]> {
    return [];
  }

  /** Start a turn with a user prompt (fire-and-forget acceptance). */
  async prompt(message: string): Promise<WireResponse> {
    this.#ensureUsable();
    this.#enqueueOrRun(message);
    return ok("prompt");
  }

  /** Queue a follow-up on a busy session (runs immediately when idle). */
  async followUp(message: string): Promise<WireResponse> {
    this.#ensureUsable();
    this.#enqueueOrRun(message);
    return ok("follow_up");
  }

  /**
   * Steer an in-flight turn — 2026-09-10 gap table: the SDK line has no steer,
   * so this is the queued-followUp approximation (plan Global Constraints:
   * "无 steer（→ followUp 队列近似）"); while idle it degrades to a plain
   * prompt, while in flight the message runs right after the current turn
   * settles.
   */
  async steer(message: string): Promise<WireResponse> {
    this.#ensureUsable();
    if (this.#inFlight && process.env.CODEX_TRACE === "1") {
      process.stderr.write("[codex-sdk] steer approximated as queued followUp (SDK gap)\n");
    }
    this.#enqueueOrRun(message);
    return ok("steer");
  }

  /**
   * Select the active model. SDK has no live setModel (2026-09-10 gap table):
   * the id is stored and applied as the `model` ThreadOption on the NEXT run —
   * via resumeThread when the thread already has an id, so conversation
   * context survives the model switch. `provider` is accepted for surface
   * parity; codex resolves models from its own catalog.
   */
  async setModel(provider: string, modelId: string): Promise<WireResponse> {
    this.#ensureUsable();
    void provider;
    this.#pendingModel = modelId;
    return ok("set_model");
  }

  /** Abort the current streaming run (AbortController per run, turn-level signal). */
  async abort(): Promise<WireResponse> {
    this.#currentAbort?.abort();
    const run = this.#currentRun;
    if (run !== null) await run; // settle first so state is deterministically idle
    return ok("abort");
  }

  /** Discard the current thread and message mirror; start fresh. */
  async newSession(): Promise<WireResponse> {
    this.#ensureUsable();
    // Invalidate THIS run's queue-drain before aborting it: its finally must
    // not start a queued message on the thread we are about to discard.
    this.#sessionEpoch += 1;
    this.#currentAbort?.abort();
    const run = this.#currentRun;
    if (run !== null) await run;
    this.#queue.length = 0;
    this.#messages.length = 0;
    this.#thread = this.#codex.startThread(this.#threadOptions);
    this.#appliedModel = null; // a pending model still applies at the next run
    return ok("new_session");
  }

  /** Lazy-surface parity: a real client is born live (see OmpAgentRpc.spawned). */
  ensureStarted(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * The current Codex thread id, exactly as the SDK thread exposes it (null
   * until the thread materializes one). The provider keeps the
   * threadId ↔ Dash-session-id index from this (Task 7).
   */
  get threadId(): string | null {
    return this.#thread.id;
  }

  /** Lazy-surface parity: a real client is born live (see OmpAgentRpc.spawned). */
  get spawned(): boolean {
    return true;
  }

  /** Release the shared-instance refcount and fail all future operations. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#sessionEpoch += 1; // a settled run must not drain the queue after close
    this.#currentAbort?.abort();
    release();
    this.#fail(new Error("codex sdk client closed"));
  }

  // -------------------------------------------------------------------------

  #ensureUsable(): void {
    if (this.#failure !== null) throw this.#failure;
    if (this.#closed) throw new Error("codex sdk client is closed");
  }

  /** Queue behind the in-flight turn, or start a run now. */
  #enqueueOrRun(message: string): void {
    if (this.#inFlight) {
      this.#queue.push(message);
      return;
    }
    this.#startRun(message);
  }

  #startRun(message: string): void {
    this.#messages.push({ role: "user", content: [{ type: "text", text: message }] });
    const run = this.#runTurn(message);
    this.#currentRun = run;
  }

  /**
   * One streamed turn: runStreamed on the thread, pump raw SDK events through
   * projectThreadEvent, mirror the conversation, settle to agent_end. Mirrors
   * the real SDK abort contract: an aborted turn just ENDS the stream (Task 1
   * spike — no throw guarantee), so it settles like a normal end; thrown errors
   * and the fatal top-level `error` event go to onFailure.
   */
  async #runTurn(message: string): Promise<void> {
    // Session epoch: bumped by newSession()/close() so a run that started on
    // the previous thread never drains the queue onto the new one.
    const epoch = this.#sessionEpoch;
    this.#inFlight = true;
    const controller = new AbortController();
    this.#currentAbort = controller;
    try {
      this.#applyPendingModel();
      const streamed = await this.#thread.runStreamed(message, { signal: controller.signal });
      for await (const raw of streamed.events) {
        const record = asRecord(raw);
        if (record !== null && record.type === "error") {
          // Fatal stream error: SDK contract surfaces it here, not as a throw.
          this.#fail(new Error(typeof record.message === "string" ? record.message : "codex stream error"));
          return;
        }
        const wire = projectThreadEvent(raw);
        if (wire !== null) {
          const events = Array.isArray(wire) ? wire : [wire];
          for (const event of events) {
            this.#emit(event);
            this.#mirror(event);
          }
        }
      }
      this.#emit({ type: "agent_end" });
    } catch (error) {
      if (controller.signal.aborted) {
        // Real SDK: the stream ends behind an abort — settle, stay idle.
        this.#emit({ type: "agent_end" });
      } else {
        this.#fail(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      this.#inFlight = false;
      this.#currentAbort = null;
      this.#currentRun = null;
      const next = this.#queue.shift();
      if (next !== undefined && epoch === this.#sessionEpoch && this.#failure === null && !this.#closed) {
        this.#startRun(next);
      }
    }
  }

  /** Rebuild the thread with the pending model when one is pending (next run). */
  #applyPendingModel(): void {
    if (this.#pendingModel === this.#appliedModel) return;
    const model = this.#pendingModel;
    const options: CodexThreadOptions =
      model === null ? { ...this.#threadOptions } : { ...this.#threadOptions, model };
    const currentId = this.#thread.id;
    this.#thread =
      currentId !== null ? this.#codex.resumeThread(currentId, options) : this.#codex.startThread(options);
    this.#appliedModel = model;
  }

  /** Mirror wire events into the getMessages accumulator (best effort). */
  #mirror(wire: WireEvent): void {
    if (wire.type === "message_end") {
      const message = asRecord(wire.message);
      if (message !== null && message.role === "assistant") {
        // Reasoning-only messages are not mirrored (see getMessages doc).
        const blocks = Array.isArray(message.content) ? (message.content as WireContentBlock[]) : [];
        const reasoningOnly = blocks.length > 0 && blocks.every((block) => block.type === "thinking");
        if (!reasoningOnly) this.#messages.push(message as unknown as WireMessage);
      }
      return;
    }
    if (wire.type === "tool_execution_end") {
      const result = asRecord(wire.result);
      this.#messages.push({
        role: "toolResult",
        toolCallId: wire.toolCallId,
        content: Array.isArray(result?.content) ? (result.content as WireContentBlock[]) : [],
        isError: wire.isError === true,
      });
      return;
    }
    if (wire.type === "turn_end") {
      const data = asRecord(wire.data);
      const usage = asRecord(data?.usage);
      if (usage !== null) this.#lastUsage = usage;
    }
  }

  #emit(event: WireEvent): void {
    if (this.#closed) return;
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch (error) {
        process.stderr.write(`codex sdk listener error: ${String(error)}\n`);
      }
    }
  }

  #fail(error: Error): void {
    if (this.#failure !== null) return;
    this.#failure = error;
    for (const listener of [...this.#failureListeners]) {
      try {
        listener(error);
      } catch (listenerError) {
        process.stderr.write(`codex sdk failure listener error: ${String(listenerError)}\n`);
      }
    }
  }
}
