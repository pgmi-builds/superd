/**
 * PiSessionClient — the SDK-line client seam: one pi `AgentSession` per Dash
 * session, driven in-process (2026-09-17 "sdk" ruling; no sidecar, no
 * `--mode rpc` subprocess).
 *
 * Lifecycle is LAZY by the omp iron law: `spawn()` builds a zero-IO shell and
 * `ensureStarted()` (first real prompt) runs the injected factory — by default
 * `createAgentSession` over the shared ModelRuntime with
 * `SessionManager.create(cwd)` (create) or `SessionManager.open(file)` (resume).
 * pi's native session JSONL materializes at that moment under `~/.pi`; the
 * provider records the file into the mapping once it exists.
 *
 * Public surface mirrors the codex client seam (`spawn` / `on` / `onFailure` /
 * `getState` / `prompt` / `followUp` / `steer` / `setModel` / `abort` /
 * `ensureStarted` / `spawned` / `close`) so the PiAgent port compiles the same
 * way CodexAgent compiles against CodexSdkClient, plus pi-only surfaces
 * (`setThinkingLevel`, `compact` — pi compaction is real and wired).
 *
 * Events flow through `projectSessionEvent` before reaching listeners; pi
 * emits its own terminal `agent_end`, so the client never synthesizes one.
 */
import { projectSessionEvent, type WireEvent } from "./pi-events.js";
import { getPiModelRuntime } from "./models.js";
import { trace } from "./knobs.js";

/** Structural shape of the pi AgentSession this client drives (duck-typed). */
export interface PiSessionLike {
  readonly sessionFile: string | undefined;
  readonly sessionId: string;
  readonly isStreaming: boolean;
  /** pi's rendered system prompt for the session (once built). */
  readonly systemPrompt?: string;
  subscribe(listener: (event: unknown) => void): () => void;
  prompt(text: string, options?: unknown): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  setModel(model: unknown): void;
  setThinkingLevel(level: string): void;
  compact(customInstructions?: string): Promise<unknown>;
  abort(): Promise<void>;
  dispose(): void;
}

/** How the factory materializes the session. */
export type PiSessionMode = { kind: "create"; tools?: string[] } | { kind: "resume"; sessionFile: string };

export interface PiSessionConfig {
  cwd: string;
  mode: PiSessionMode;
}

export type PiSessionFactory = (config: PiSessionConfig) => Promise<PiSessionLike>;

/** Default factory: the real SDK, over the shared ModelRuntime. */
let sessionFactory: PiSessionFactory = async ({ cwd, mode }) => {
  const sdk = (await import("@earendil-works/pi-coding-agent")) as unknown as {
    createAgentSession: (options: unknown) => Promise<{ session: PiSessionLike }>;
    SessionManager: {
      create(cwd: string, sessionDir?: string, options?: unknown): unknown;
      open(path: string, sessionDir?: string, cwdOverride?: string): unknown;
    };
  };
  const modelRuntime = await getPiModelRuntime();
  const sessionManager =
    mode.kind === "resume" ? sdk.SessionManager.open(mode.sessionFile) : sdk.SessionManager.create(cwd);
  const { session } = await sdk.createAgentSession({
    modelRuntime,
    sessionManager,
    cwd,
    ...(mode.kind === "create" && mode.tools !== undefined && mode.tools.length > 0 ? { tools: mode.tools } : {}),
  });
  return session;
};

/** Replace the session factory (tests inject a fake). */
export function setPiSessionFactory(factory: PiSessionFactory): void {
  sessionFactory = factory;
}

/** `get_state`-shaped payload (the codex WireState port). */
export interface WireState {
  isStreaming: boolean;
}

export interface WireResponse {
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
}

function ok(command: string, data?: unknown): WireResponse {
  return { type: "response", command, success: true, ...(data === undefined ? {} : { data }) };
}

export class PiSessionClient {
  #session: PiSessionLike | undefined;
  #startPromise: Promise<void> | undefined;
  #closed = false;
  readonly #listeners = new Set<(event: WireEvent) => void>();
  readonly #failureListeners = new Set<(error: Error) => void>();

  constructor(readonly config: PiSessionConfig) { }

  /**
   * Build the client shell. Zero IO: the factory runs only at
   * `ensureStarted()`. `args` is accepted for omp-seam parity and must be
   * empty — unknown values fail loud (the SDK line has no spawn flags).
   */
  static async spawn(args: string[], cwd: string, mode: PiSessionMode): Promise<PiSessionClient> {
    if (args.length > 0) {
      throw new Error(`PiSessionClient: unsupported spawn arg "${String(args[0])}" (SDK line)`);
    }
    return new PiSessionClient({ cwd, mode });
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

  /** Whether the underlying pi session exists (and the client is not closed). */
  get spawned(): boolean {
    return this.#session !== undefined && !this.#closed;
  }

  /** pi's native session file; `null` until the session materializes it. */
  get sessionFile(): string | null {
    return this.#closed || this.#session === undefined ? null : this.#session.sessionFile ?? null;
  }

  /**
   * pi's own system prompt, once the session started (undefined before —
   * callers retry on later steps).
   */
  systemPrompt(): string | undefined {
    if (this.#closed || this.#session === undefined) return undefined;
    const prompt = this.#session.systemPrompt;
    return typeof prompt === "string" && prompt.trim() !== "" ? prompt : undefined;
  }

  /** Materialize the session once; memoized after that. */
  ensureStarted(): Promise<void> {
    this.#usable();
    this.#startPromise ??= (async () => {
      const session = await sessionFactory(this.config);
      this.#session = session;
      session.subscribe((event) => this.#pump(event));
      trace(`session started mode=${this.config.mode.kind} file=${session.sessionFile ?? "none"}`);
    })();
    return this.#startPromise;
  }

  /** Query streaming state. Does NOT start the session (cold reads stay cold). */
  getState(): WireState {
    this.#usable();
    if (this.#session === undefined) return { isStreaming: false };
    return { isStreaming: this.#session.isStreaming === true };
  }

  /** Start a run with a user prompt (fire-and-forget past the lazy boundary). */
  async prompt(message: string): Promise<WireResponse> {
    this.#usable();
    await this.ensureStarted();
    void this.#session!.prompt(message).catch((error) => this.#fail(error));
    return ok("prompt");
  }

  /** Queue a steering message while streaming (pi supports this natively). */
  async steer(message: string): Promise<WireResponse> {
    this.#usable();
    await this.ensureStarted();
    void this.#session!.steer(message).catch((error) => this.#fail(error));
    return ok("steer");
  }

  /** Queue a follow-up for when the agent stops. */
  async followUp(message: string): Promise<WireResponse> {
    this.#usable();
    await this.ensureStarted();
    void this.#session!.followUp(message).catch((error) => this.#fail(error));
    return ok("follow_up");
  }

  /**
   * Select the model by its real route pair: the provider slug plus the BARE
   * model id, threaded straight into the shared runtime's `getModel`.
   * Legacy composite `<provider>/<modelId>` selections are resolved
   * upstream (agent.ts) before reaching here. An unknown pair logs and
   * no-ops (never breaks the agent loop mid-session — codex catch
   * semantics); an incomplete pair is likewise a logged no-op.
   */
  async setModel(provider: string, modelId: string): Promise<WireResponse> {
    this.#usable();
    if (provider === "" || modelId === "") {
      trace(`set_model: incomplete route (${provider}/${modelId}), ignored`);
      return ok("set_model");
    }
    await this.ensureStarted();
    const runtime = await getPiModelRuntime();
    const model = runtime.getModel(provider, modelId);
    if (model === undefined) {
      trace(`set_model: runtime has no ${provider}/${modelId}, ignored`);
      return ok("set_model");
    }
    this.#session!.setModel(model);
    trace(`set_model → ${provider}/${modelId}`);
    return ok("set_model");
  }

  /** Set the thinking level (off..max); no-op before the session exists. */
  setThinkingLevel(level: string): void {
    this.#usable();
    this.#session?.setThinkingLevel(level);
  }

  /** Run pi compaction (wired unlike codex); fire-and-forget with failure channel. */
  async compact(customInstructions?: string): Promise<WireResponse> {
    this.#usable();
    await this.ensureStarted();
    void this.#session!.compact(customInstructions).catch((error) => this.#fail(error));
    return ok("compact");
  }

  /** Abort the current operation; resolves when the session is idle again. */
  async abort(): Promise<WireResponse> {
    this.#usable();
    if (this.#session !== undefined) await this.#session.abort();
    return ok("abort");
  }

  /** Dispose the session. Idempotent; all later operations fail. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#session?.dispose();
    } catch (error) {
      trace(`dispose threw: ${String(error)}`);
    }
    this.#fail(new Error("pi session client closed"));
  }

  // -------------------------------------------------------------------------

  #usable(): void {
    if (this.#closed) throw new Error("pi session client is closed");
  }

  #pump(raw: unknown): void {
    const wire = projectSessionEvent(raw);
    if (wire === null) return;
    for (const listener of [...this.#listeners]) {
      try {
        listener(wire);
      } catch (error) {
        process.stderr.write(`pi sdk listener error: ${String(error)}\n`);
      }
    }
  }

  #fail(error: unknown): void {
    const resolved = error instanceof Error ? error : new Error(String(error));
    trace(`failure: ${resolved.message}`);
    for (const listener of [...this.#failureListeners]) {
      try {
        listener(resolved);
      } catch (listenerError) {
        process.stderr.write(`pi sdk failure listener error: ${String(listenerError)}\n`);
      }
    }
  }
}
