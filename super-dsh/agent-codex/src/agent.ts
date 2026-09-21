/**
 * CodexAgent — the Dash `Agent` shim over one `CodexSdkClient` (an
 * @openai/codex-sdk thread handle).
 *
 * Bridges Codex's wire event stream (the omp wire vocabulary projected by
 * codex-events.ts) into the Dash `SessionEventMap`:
 *
 *   Codex wire                       →  Dash session event
 *   ─────────────────────────────────────────────────────────────
 *   (send/followup delivers)         →  turn/start + user/message
 *   turn_start                       →  step/start
 *   message_update(text_delta)       →  (v2 stream frame, no log event)
 *   message_end(assistant)           →  buffered; flushed as assistant/message
 *                                        (+ usage, reasoning) at turn_end
 *   tool_execution_start             →  tool/call
 *   tool_execution_end               →  tool/result
 *   turn_end                         →  final assistant/message (+ usage) + step/end
 *   todo_write                       →  todo/write (log-only whole-list snapshot)
 *   agent_end                        →  turn/end + status idle
 *
 * One Dash turn (user prompt → final answer) spans multiple Codex turns (one
 * assistant response + its tool executions each), so Dash turn/step
 * boundaries are synthesized around the wire stream. The event `type`
 * strings are IDENTICAL to the omp bridge's — this is the same switch, with
 * the SDK-line cuts applied: no approval cards (extension_ui_request has no
 * source on the SDK line; the approval policy is a launch-only preset), no
 * supervisor (no foreign writer to avoid), no bridge store.
 *
 * Token usage: Codex reports accounting only at `turn_end` (per turn, not
 * per model call), while Dash carries usage on `assistant/message`. The
 * turn's FINAL assistant message is therefore buffered and flushed at
 * `turn_end`, so the usage lands on a message of the SAME turn — the DSH
 * turn-token fold (`deriveTurnTokenUsage`) refuses cross-turn samples
 * (plan RC-6: the old one-turn lag made every usage sample unprovable).
 */
import type { Context } from "@deepseek-ai/cordis";
import type {
  Agent,
  AssistantStreamFrame,
  AgentOptions,
  AgentStatus,
  CancelOptions,
  InboxTarget,
} from "@deepseek-ai/dsh-agent";
import { agentEvents, type AgentEventDispatch } from "@deepseek-ai/dsh-agent";
import { Inbox } from "./inbox.js";
import type {
  AgentCancelCause,
  Session,
  SessionId,
  TurnEndReason,
  SessionSeq,
  UserMessage,
} from "@deepseek-ai/dsh-session";
import type { AssistantMessage, AssistantStreamRecord, ContentBlock, StreamChunk, TokenUsage } from "@deepseek-ai/dsh-llm";
import { LlmAttemptId, ToolCallId, QUOTA_EXCEEDED_CODE, createAssistantMessage, createSystemMessage, createToolResultMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { createScope, type Scope } from "@deepseek-ai/dsh-scope";
import type { WireAssistantMessageEvent, WireContentBlock, WireEvent, WireMessage } from "./codex-events.js";
import type { CodexSdkClient } from "./codex-client.js";
// Type-only: pulls dsh-commands' `Context.commands` augmentation into this
// compilation (the runtime service is mounted by the base bundle).
import type { CommandInvocation, CommandResult } from "@deepseek-ai/dsh-commands";

/**
 * v2 live assistant-stream publication for the Codex bridge — the same frame
 * protocol the reference loop's AssistantStreamAttempt speaks (start marker,
 * dense zero-based chunks, terminal settlement) emitted over this agent's own
 * dispatch, so the session-controller folds Codex's stream into its reconnect
 * baseline. Chunks also accumulate as raw durable records embedded in the
 * final assistant/message.
 */
class AssistantStreamBridge {
  readonly attemptId: LlmAttemptId;
  readonly records: AssistantStreamRecord[] = [];
  #nextRevision: () => number;
  #emit: (frame: AssistantStreamFrame) => void;
  #index = 0;
  #terminal = false;

  constructor(sessionId: SessionId, attempt: number, nextRevision: () => number, emit: (frame: AssistantStreamFrame) => void) {
    this.attemptId = LlmAttemptId(`${sessionId}:${attempt}`);
    this.#nextRevision = nextRevision;
    this.#emit = emit;
  }

  /** Whether the terminal frame already fired. */
  get ended(): boolean {
    return this.#terminal;
  }

  /** Opening marker before the first delivered chunk. */
  start(turn: number, step: number): void {
    this.#emit({ type: "start", attemptId: this.attemptId, revision: this.#nextRevision(), turn, step });
  }

  /** One live chunk: durable record plus dense process-local frame. */
  push(chunk: StreamChunk): void {
    const time = Date.now();
    this.records.push({ type: "chunk", time, chunk });
    this.#emit({ type: "chunk", attemptId: this.attemptId, revision: this.#nextRevision(), index: this.#index++, time, chunk });
  }

  /** Terminal settlement after the durable assistant/message committed. */
  settle(seq: SessionSeq): void {
    this.#terminal = true;
    this.#emit({ type: "end", attemptId: this.attemptId, revision: this.#nextRevision(), index: this.#index, outcome: { kind: "committed", eventType: "assistant/message", seq } });
  }

  /** No durable attempt event will commit. */
  abandon(): void {
    this.#terminal = true;
    this.#emit({ type: "end", attemptId: this.attemptId, revision: this.#nextRevision(), index: this.#index, outcome: { kind: "abandoned" } });
  }
}

/** Diagnostic trace (set CODEX_TRACE=1 on the dsh process to enable). */
const TRACE = process.env.CODEX_TRACE === "1";
const trace = (...parts: unknown[]): void => {
  if (TRACE) process.stderr.write(`[codex-agent ${Date.now() % 1_000_000}] ${parts.join(" ")}\n`);
};

export function convertContent(blocks: WireContentBlock[] | undefined): ContentBlock[] {
  if (blocks === undefined) return [];
  const result: ContentBlock[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        if (typeof block.text === "string") result.push({ type: "text", text: block.text });
        break;
      case "thinking":
        if (typeof block.thinking === "string") result.push({ type: "reasoning", text: block.thinking });
        break;
      case "toolCall": {
        const id = typeof block.id === "string" ? block.id : "";
        const name = typeof block.name === "string" ? block.name : "";
        const args = typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments ?? {});
        result.push({ type: "tool-call", id: ToolCallId(id), name, arguments: args });
        break;
      }
      default:
        // images / unknown blocks are not bridged in V1.
        break;
    }
  }
  return result;
}

/**
 * Classify the wire's `stopReason: "error"` assistant message into a Dash
 * `failure` (`{ message, code }`). This is the same taxonomy the harness
 * adapters use for `turn/end` reasons — `AUTH`, `RATE_LIMIT`, `QUOTA`,
 * `SERVER` — so the Web UI renders it through its own error path instead of
 * an empty assistant bubble. Quota/usage wording is checked before the
 * generic 403→AUTH because some providers report an exhausted billing quota
 * as HTTP 403.
 */
export function wireFailure(message: WireMessage): { message: string; code: string } | undefined {
  if (message.stopReason !== "error") return undefined;
  const status = typeof message.errorStatus === "number" ? message.errorStatus : undefined;
  const text =
    typeof message.errorMessage === "string" && message.errorMessage.trim() !== ""
      ? message.errorMessage.trim()
      : undefined;
  const detail = text ?? "";
  let code: string;
  if (/\b(?:usage|rate)\s*limit\b/i.test(detail) || /\bquota\b/i.test(detail) || /\bbilling\b/i.test(detail) || /\binsufficient\b/i.test(detail)) {
    code = QUOTA_EXCEEDED_CODE;
  } else if (status === 401 || status === 403) {
    code = "AUTH";
  } else if (status === 429) {
    code = "RATE_LIMIT";
  } else if (status !== undefined && status >= 500) {
    code = "SERVER";
  } else {
    code = "UNKNOWN";
  }
  return { message: text ?? (status !== undefined ? `HTTP ${status}` : "model request failed"), code };
}

/**
 * Classify a NATIVE failure (the codex process / SDK stream itself, surfaced
 * through `onFailure`) into the stable turn-error codes the resume surface
 * uses (plan RC-4): a missing or unreadable rollout is `ROLLOUT_MISSING`; any
 * other refusal of the native resume/re-attach is `NATIVE_REJECTED`.
 * Model-side failures that ride the wire as `stopReason: "error"` are
 * classified by {@link wireFailure} instead. Unrecognized shapes stay
 * `UNKNOWN` — only the two stable codes mark the session not resumable.
 */
export function classifyNativeFailure(error: unknown): { message: string; code: string } {
  const text = error instanceof Error ? error.message : String(error);
  if (
    /rollout|no such (session|thread)|(session|thread)[\w -]{0,24}not[\w -]{0,8}found|unable to (find|locate|load|read|resume)|failed to (load|read|resume)/i.test(
      text,
    )
  ) {
    return { message: text, code: "ROLLOUT_MISSING" };
  }
  if (/resume|re-?attach|corrupt|invalid[\w -]{0,24}(session|thread)/i.test(text)) {
    return { message: text, code: "NATIVE_REJECTED" };
  }
  return { message: text, code: "UNKNOWN" };
}
/**
 * Map Codex's turn usage accounting into Dash `TokenUsage`. Codex reports
 * five disjoint snake_case counters per turn (`turn_end.data.usage`) and its
 * `reasoning_output_tokens` is ADDITIVE to `output_tokens` (the captured
 * fixture shows output 3, reasoning 18), while the DSH turn fold requires
 * reasoning ⊆ output plus an exact `totalTokens` when both cache buckets are
 * present (upstream token-meter `normalizeUsage`). The total is therefore
 * synthesized from Codex's own counters:
 *
 *   totalTokens = input + cachedInput + cacheWrite + output + reasoning
 *
 * Emission rules (plan ruling 6 — omp/pi shape, no invented tokens):
 *  - a cache bucket rides through only when > 0 (a zero bucket carries no
 *    information but would trip the fold's both-buckets exact-prompt
 *    equality for nothing);
 *  - `reasoningTokens` rides through only when it fits the fold's subset
 *    rule (`reasoning <= output`); codex's additive reasoning is otherwise
 *    omitted from the breakdown while still counted in the synthesized
 *    total (fail-closed fold philosophy: no attempt is inferred from a
 *    contradictory sample).
 */
export function convertUsage(usage: unknown): TokenUsage | undefined {
  if (usage === null || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const count = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const inputTokens = count(u.input_tokens) ?? 0;
  const outputTokens = count(u.output_tokens) ?? 0;
  if (inputTokens === 0 && outputTokens === 0) return undefined;
  const cachedInput = count(u.cached_input_tokens);
  const cacheWrite = count(u.cache_write_input_tokens);
  const reasoning = count(u.reasoning_output_tokens);
  const cacheReadTokens = cachedInput !== undefined && cachedInput > 0 ? cachedInput : undefined;
  const cacheWriteTokens = cacheWrite !== undefined && cacheWrite > 0 ? cacheWrite : undefined;
  const reasoningTokens = reasoning !== undefined && reasoning > 0 && reasoning <= outputTokens ? reasoning : undefined;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0) + outputTokens + (reasoning ?? 0),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

/** Join the visible text blocks of a Dash user message into the Codex prompt string. */
function userMessageText(message: UserMessage): string {
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text") parts.push(block.text);
  }
  return parts.join("\n");
}

/**
 * Dash-host plugin narration from the approval service: the policy-change
 * notice `agent.inject` carries when `/permission` switches a live session's
 * approval policy. Codex has no runtime approval control either (the policy
 * is pinned at launch via the preset mapping; no SDK surface changes it
 * mid-session), so forwarding the text would steer it into an in-flight turn
 * (interrupting tool work) and echo it into history as a fake user prompt.
 * Detect and drop it.
 */
function isApprovalNarration(message: UserMessage): boolean {
  const source = message.source;
  return source.kind === "plugin" && source.plugin === "user-approval";
}

/**
 * Reconstruct a Dash user message from a wire `message_start(role=user)`
 * payload. Used only as a defensive fallback when a queued delivery's
 * retained message is missing (the client echoes text, so the visible
 * content is preserved).
 */
function userMessageFromWire(message: WireMessage): UserMessage {
  return createUserMessage({
    content: convertContent(message.content).filter((block) => block.type === "text"),
    source: { kind: "user" },
  });
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long an agent may sit idle before its codex client is torn down. The
 * Dash host keeps resumed agents registered forever (nothing else disposes
 * them), and every idle agent pins a live thread. Tearing the agent down at
 * idle costs nothing observable — the next prompt cold-resumes the session
 * from Codex's rollout through the replay persistence. `0` disables the exit.
 */
const CODEX_IDLE_EXIT_MS = parseIdleExit(process.env.CODEX_IDLE_EXIT_MS);

function parseIdleExit(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 600_000;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : 600_000;
}

/**
 * The slice of `ctx.agentDefaultModel` the model-sync path reads. Typed
 * locally so the agent needs no dependency on the dsh-agent-default-model
 * package; the apiproxy writes the selection through `saveSelection` on
 * `session.selectModel`.
 */
interface AgentDefaultModelSlice {
  currentSelection(): { provider: string; model: string };
}

/**
 * Adapter-owned runtime facts the agent stamps into the session log. Both are
 * lazy on purpose: the Codex system prompt only becomes readable once the
 * thread's rollout HEAD exists (after the first turn starts), and the catalog
 * may be unreadable at boot — each call fail-softs to `undefined`, and the
 * agent simply retries or skips.
 */
export interface CodexAgentRuntimeInfo {
  /** Codex's own system prompt for this session's thread, when readable. */
  systemPrompt(): string | undefined;
  /**
   * The effective codex route for this session: `preferredModel` (the
   * session's selected codex model) wins, else the catalog default. Returns
   * `undefined` when neither is known.
   */
  routeContext(preferredModel: string | undefined): { provider: string; model: string; contextWindow?: number } | undefined;
  /**
   * Mark this session's identity-map record not resumable — called when the
   * native runtime rejects the session's thread at turn time (plan RC-4),
   * so a later resume fails fast with the stable code instead of burning
   * another turn. Optional: absent when no runtime bridge is mounted.
   */
  markNotResumable?(): void;
}

export class CodexAgent implements Agent {
  readonly id: SessionId;
  readonly options: AgentOptions;
  readonly session: Session;
  readonly inbox: Inbox;
  readonly ctx: Context;
  readonly #client: CodexSdkClient;
  readonly #loopCtx: Context;
  readonly #scope: Scope;
  readonly #dispatch: AgentEventDispatch;

  #streaming = false;
  #activityDone: Promise<void> = Promise.resolve();
  #resolveActivityDone: () => void = () => { };
  #dashTurn = 0;
  #step = 0;
  #lastTurn = 0;
  #turnOpen = false;
  #cancelCause: AgentCancelCause | null = null;
  /** Terminal model failure of the open turn (`message_end` stopReason "error"); consumed by `agent_end`. */
  #pendingFailure: { message: string; code: string } | null = null;
  /** Live v2 assistant-stream publication for the in-flight wire message. */
  #streamBridge: AssistantStreamBridge | undefined;
  #assistantAttemptCounter = 0;
  #assistantStreamRevision = 0;

  /** The current turn's user/message was appended locally and the echo is still awaited. */
  #localUserPending = false;
  /** A `turn_start` arrived; `step/start` is deferred until the step's owning turn is known. */
  #stepStartPending = false;
  /**
   * Deliveries forwarded through the client's own queue, in submission order.
   * The client echoes each as `message_start(role=user)`; the bridge maps it
   * by transport: a `followUp` echo closes the current Dash turn and opens a
   * fresh one (the client queues it and auto-generates the next turn), a
   * `steer` echo appends a `user/message` step to the current turn. `sent`
   * marks entries already dispatched to the client (a parked injection
   * flushes at agent_start).
   */
  #remoteQueue: { message: UserMessage; sent: boolean; transport: "followUp" | "steer" }[] = [];
  #bridgedToolResults = new Set<string>();
  /**
   * The open turn's FINAL assistant message, buffered from `message_end`
   * until `turn_end` so the SAME turn's usage can land on it (the DSH
   * turn-token fold refuses cross-turn samples). Flushed usage-less on
   * failure/abort paths so the turn's visible text is never dropped.
   */
  #deferredAssistant: WireMessage | null = null;
  /** The last selection already synced to the client via `set_model`, as `provider/model`. */
  #lastSyncedModel: string | null = null;
  /** Fires when the agent has been idle past CODEX_IDLE_EXIT_MS (tears down the client). */
  readonly #onIdleExit: (() => void) | undefined;
  #idleExitTimer: NodeJS.Timeout | undefined = undefined;
  #disposed = false;
  /** One-shot guard for the first-turn session-identity commit (#bootstrapSessionIdentity). */
  #sessionIdentityCommitted = false;
  /** Adapter-owned runtime facts (system prompt / route metadata), when supplied. */
  readonly #runtimeInfo: CodexAgentRuntimeInfo | undefined;
  /** One-shot guard for the `system/message` surface node (never re-emitted). */
  #systemMessageDone = false;
  /** Last `request/context` route key (`provider/model`) — dedupes per-turn emits. */
  #lastRouteKey: string | null = null;

  constructor(loopCtx: Context, id: SessionId, options: AgentOptions, session: Session, client: CodexSdkClient, onIdleExit?: () => void, runtimeInfo?: CodexAgentRuntimeInfo) {
    this.#loopCtx = loopCtx;
    this.id = id;
    this.options = options;
    this.session = session;
    this.#client = client;
    this.#onIdleExit = onIdleExit;
    this.#runtimeInfo = runtimeInfo;
    this.#dispatch = agentEvents(loopCtx, this);
    this.inbox = new Inbox();
    this.#scope = createScope(loopCtx, this);
    this.ctx = this.#scope.ctx.extend({ agent: this });
    this.#lastTurn = session.snapshotEvents().findLast((event) => event.type === "turn/start")?.data.turn ?? 0;
    client.on((event) => this.#handleEvent(event));
    client.onFailure((error) => this.#fail(error));
    // Session-identity events (the agent-preset stamp) are committed on the
    // FIRST turn by #bootstrapSessionIdentity — only once the client actually
    // exists — so a freshly created session announces completely blank,
    // exactly like the native agent-loop factory's: the backend takes zero
    // part in the UI's browser-local new-session draft.
    // `/permission` cannot work here: Codex pins the approval policy at
    // launch and no SDK surface changes it mid-session. Registering the SAME
    // name on this agent's own scope (a command-injected child of `agent.ctx`)
    // SHADOWS the global permission command for this agent only — the switch
    // then fails cleanly instead of appending approval/policy events Codex
    // cannot honor. (The `inject` narration drop below stays as the backstop.)
    this.ctx.inject(["commands"], (cmdCtx) =>
      cmdCtx.commands.register({
        name: "permission",
        description: "Unavailable for Codex sessions (approval policy is fixed at Codex launch)",
        input: { hint: "<preset>" },
        handler: () => ({
          kind: "error" as const,
          text: "Approval policy is fixed at Codex launch; runtime switching is not supported for Codex sessions.",
        }),
      }),
    );
    // `/compact` parity: the SDK line exposes no compaction surface (V1 gap
    // table: no messages surgery/compact — fail-soft default). Shadowing the
    // loop-owned global name keeps the (disabled) native pipeline from
    // receiving it; the command node renders the clean refusal natively.
    this.ctx.inject(["commands"], (cmdCtx) =>
      cmdCtx.commands.register({
        name: "compact",
        description: "Unavailable for Codex sessions (the SDK line has no compaction surface)",
        input: { hint: "[instructions]" },
        handler: () => ({
          kind: "error" as const,
          text: "Compaction is not available for Codex sessions: the SDK line has no compaction surface.",
        }),
      }),
    );
  }

  get status(): AgentStatus {
    return this.#streaming ? "running" : "idle";
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    this.#deliver(message, target, wakeup);
  }

  followup(message: UserMessage): void {
    // The Web UI's `session.prompt` (mode "queue") routes through followup.
    // Idle → `prompt` (opens the Dash turn locally); busy → the client's own
    // queue (delivered as the next turn's user message and auto-generated).
    // Mirrors dsh-agent-loop's `followup = send(input, "next-turn", true)`.
    this.#deliver(message, "next-turn", true);
  }

  steer(message: UserMessage): void {
    // Mirrors dsh-agent-loop's `steer = send(input, "next-step", true)`: an
    // idle driver starts a turn; a running driver consumes it at the next
    // step (on the SDK line: queued followUp after the in-flight turn).
    this.#deliver(message, "next-step", true);
  }

  inject(message: UserMessage): void {
    // Dash-host approval-policy narrations have no Codex runtime equivalent
    // (the policy is pinned at launch; no SDK surface changes it mid-session).
    // Forwarding the text would steer it into an in-flight turn — interrupting
    // tool work — and echo it into history as a fake user prompt. Drop it; the
    // accompanying `approval/policy` session event stays recorded so the UI's
    // permission state remains truthful.
    if (isApprovalNarration(message)) {
      trace("inject: dropped approval-policy narration (Codex lacks runtime approval control)");
      return;
    }
    // Mirrors dsh-agent-loop's `inject = send(input, "next-step", false)`:
    // queued without waking; idle drivers leave it pending until a later
    // follow-up/steer wakes them (flushed at the next agent_start).
    this.#deliver(message, "next-step", false);
  }

  cancel(cause: AgentCancelCause, _options?: CancelOptions): void {
    // No active run → no-op: arming `#cancelCause` here would misreport a later,
    // unrelated completed turn as aborted. First cause wins: later cancels must
    // not overwrite an earlier cause (dash contract).
    if (!this.#streaming) return;
    if (this.#cancelCause === null) this.#cancelCause = cause;
    void this.#client.abort().catch(() => { });
  }

  async whenIdle(): Promise<void> {
    // Event-driven: wait for the current activity to settle (agent_end), then
    // confirm the client reports quiescence via get_state (the mapping's poll).
    let activity: Promise<void>;
    do {
      activity = this.#activityDone;
      await activity;
    } while (activity !== this.#activityDone);
    for (; ;) {
      const state = await this.#client.getState().catch(() => null);
      if (state === null || !state.isStreaming) return;
      await delay(50);
    }
  }

  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    // Codex has no maintenance concept; run the task directly.
    return task(new AbortController().signal);
  }

  /** Stop the codex client and unwind the scoped world. Idempotent. */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    clearTimeout(this.#idleExitTimer);
    this.#idleExitTimer = undefined;
    this.#client.close();
    await this.#scope.dispose();
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * Route one message by the reference loop's (target, wakeup) semantics:
   * an idle waking delivery starts a fresh local turn (`prompt`); a follow-up
   * sent while a turn is open is forwarded to the client's own queue
   * (`followUp`: the client delivers it as the next turn's user message and
   * auto-generates that turn); steering/injection goes through `steer`
   * (consumed at the next step, or parked until agent_start when not yet
   * streaming).
   *
   * Busy is the LOCAL turn state (`#turnOpen`), not the `#streaming` flag:
   * the client needs a moment to emit `agent_start` after a prompt, and in
   * that gap a bare `prompt` is still safe on the SDK line, but keeping the
   * omp queuing semantics makes the echo mapping identical.
   */
  #deliver(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    if (this.#disposed) return;
    const busy = this.#turnOpen || this.#streaming;
    trace(`#deliver target=${target} wakeup=${wakeup} busy=${busy} (turnOpen=${this.#turnOpen} streaming=${this.#streaming})`);
    if (busy && target === "next-turn") {
      this.#queueRemote(message, "followUp");
      return;
    }
    if (busy || !wakeup) {
      this.#queueRemote(message, "steer");
      return;
    }
    this.#deliverPrompt(message);
  }
  #deliverPrompt(message: UserMessage): void {
    if (this.#disposed) return;
    trace(`#deliverPrompt turn=${this.#dashTurn + 1} text="${userMessageText(message).slice(0, 40)}"`);
    // Reserve the turn synchronously: busy-flag semantics stay identical to
    // the eager line (a second delivery during the cold start queues
    // remotely), but NOTHING is appended yet — the log stays empty until the
    // client exists, so a failed cold start leaves no orphan turn.
    this.#reserveTurn();
    clearTimeout(this.#idleExitTimer);
    this.#idleExitTimer = undefined;
    this.#beginActivity();
    void this.#startTurn(message);
  }

  /**
   * Cold-start path for one reserved turn: confirm the client is started,
   * commit the session-identity events ahead of the turn (the agent-preset
   * stamp), sync the model, then append turn/start + user/message and
   * dispatch. A failed cold start synthesizes the failed turn (turn/end with
   * the error reason) so the UI's error path renders it, then unwinds the
   * reservation.
   */
  async #startTurn(message: UserMessage): Promise<void> {
    try {
      await this.#client.ensureStarted();
      await this.#bootstrapSessionIdentity();
      await this.#syncModelSelection();
    } catch (error) {
      trace(`#startTurn cold start failed: ${String(error)}`);
      if (this.#turnOpen) {
        this.session.append("turn/start", { turn: this.#dashTurn });
        this.session.append("user/message", message, { surfaceOp: "append" });
        this.#closeTurn({ kind: "error", error: { message: String(error), code: "UNKNOWN" } });
      }
      this.#endActivity();
      return;
    }
    if (this.#disposed) return;
    this.session.append("turn/start", { turn: this.#dashTurn });
    this.#emitRequestContext();
    this.session.append("user/message", message, { surfaceOp: "append" });
    void this.#client.prompt(userMessageText(message)).catch((error) => this.#fail(error));
  }

  /**
   * Stamp the Codex system prompt once per session as the step's surface node.
   * `system/message` is a step-scoped surface event, so this runs only after
   * `step/start` committed (inside the first open step of the first turn).
   * Skips when the log already carries one (resume), when the adapter has no
   * runtime bridge, and while the rollout HEAD is not yet readable — the call
   * is retried on later steps until the text is available.
   */
  #emitSystemMessage(): void {
    if (this.#systemMessageDone) return;
    if (this.#runtimeInfo === undefined || !this.#turnOpen) return;
    this.#commitStepStart();
    if (this.#step === 0) return;
    if (this.session.snapshotEvents().some((event) => event.type === "system/message")) {
      this.#systemMessageDone = true;
      return;
    }
    const text = this.#runtimeInfo.systemPrompt();
    if (text === undefined || text.trim() === "") return;
    this.session.append(
      "system/message",
      {
        turn: this.#dashTurn,
        step: this.#step,
        message: createSystemMessage(text, "aw.agent-adapter-codex"),
      },
      { surfaceOp: "append" },
    );
    this.#systemMessageDone = true;
    trace(`system/message stamped (${text.length} chars)`);
  }

  /**
   * Stamp route metadata for the next request (`request/context`): the
   * effective provider/model plus the catalog's context window when known.
   * Turn-enclosed (no step required) and deduped by route key, so it lands at
   * the start of a turn and again only when the effective route changes.
   */
  #emitRequestContext(): void {
    if (this.#runtimeInfo === undefined || !this.#turnOpen) return;
    const route = this.#runtimeInfo.routeContext(this.options.model);
    if (route === undefined) return;
    const key = `${route.provider}/${route.model}`;
    if (key === this.#lastRouteKey) return;
    this.#lastRouteKey = key;
    this.session.append("request/context", {
      provider: route.provider,
      model: route.model,
      ...(route.contextWindow === undefined ? {} : { contextWindow: route.contextWindow }),
    });
    trace(`request/context ${key}${route.contextWindow === undefined ? "" : ` ctx=${route.contextWindow}`}`);
  }

  /**
   * One-shot first-turn identity commit: the agent-preset stamp (idempotent).
   * The SDK line exposes no system-prompt surface, so — unlike the omp
   * bridge — no `system/message` node is emitted here; a Codex session's
   * system prompt is Codex's own and never crosses the wire. The guard —
   * skip when the seed already carries a `system/message` — stays for shape
   * parity with resumed logs that might carry one.
   */
  async #bootstrapSessionIdentity(): Promise<void> {
    if (this.#sessionIdentityCommitted) return;
    this.#sessionIdentityCommitted = true;
    if (!this.session.snapshotEvents().some((event) => event.type === "agent-preset/selected" && event.data?.agentPreset === "codex")) {
      this.session.append("agent-preset/selected", { agentPreset: "codex" });
    }
    // The system prompt is stamped separately by #emitSystemMessage once the
    // thread's rollout HEAD is readable (Codex's own prompt is recovered from
    // `session_meta.base_instructions`, never from a wire message).
  }

  /**
   * Queue a message for client-side delivery. `followUp` dispatches
   * immediately (state-safe whether or not the client is streaming); `steer`
   * dispatches now when already streaming, otherwise parks until
   * agent_start.
   */
  #queueRemote(message: UserMessage, transport: "followUp" | "steer"): void {
    if (this.#disposed) return;
    clearTimeout(this.#idleExitTimer);
    this.#idleExitTimer = undefined;
    this.#remoteQueue.push({ message, sent: false, transport });
    if (this.#streaming || transport === "followUp") this.#flushRemote();
  }

  #flushRemote(): void {
    void this.#syncModelSelection().finally(() => {
      for (const entry of this.#remoteQueue) {
        if (entry.sent) continue;
        entry.sent = true;
        const text = userMessageText(entry.message);
        const sent = entry.transport === "followUp" ? this.#client.followUp(text) : this.#client.steer(text);
        trace(`-> ${entry.transport} "${text.slice(0, 40)}"`);
        void sent.catch((error) => this.#fail(error));
      }
    });
  }

  /**
   * Push the effective model selection into the client before a turn is
   * dispatched. The SDK has no live setModel, so the client stores the id
   * and applies it as the next run's ThreadOption (via resumeThread, so the
   * conversation context survives). The omp waterfall pair
   * (system-prompt assemble → agent/request) is a V1 cut: the base is the
   * session's logged `request/header` falling back to the global
   * `agentDefaultModel` selection, else the agent options — the apiproxy's
   * installed selection IS the global one this process serves.
   */
  async #syncModelSelection(): Promise<void> {
    const persisted = this.session.requestHeader()?.config;
    const service = this.ctx.get("agentDefaultModel") as AgentDefaultModelSlice | undefined;
    const selection = service?.currentSelection();
    const target =
      persisted !== undefined && persisted.provider !== "" && persisted.model !== ""
        ? { provider: persisted.provider, model: persisted.model }
        : selection !== undefined && selection.provider !== "" && selection.model !== ""
          ? selection
          : { provider: this.options.provider ?? "", model: this.options.model ?? "" };
    if (target.provider === "" || target.model === "") return;
    const key = `${target.provider}/${target.model}`;
    if (key === this.#lastSyncedModel) return;
    await this.#client.setModel(target.provider, target.model).catch((error) => {
      trace(`set_model ${key} failed: ${String(error)}`);
    });
    this.#lastSyncedModel = key;
  }

  /**
   * Reserve a turn WITHOUT appending anything: the prompt path reserves
   * synchronously, then commits turn/start + user/message only after the
   * cold start (#startTurn). #openTurn keeps the eager append for paths that
   * run against an already-live client (#bridgeRemoteUser echoes).
   */
  #reserveTurn(): void {
    if (this.#turnOpen) return;
    this.#dashTurn = ++this.#lastTurn;
    this.#step = 0;
    this.#turnOpen = true;
    this.#localUserPending = true;
  }

  #openTurn(message: UserMessage, localUser = true): void {
    trace(`#openTurn turnOpen=${this.#turnOpen} -> turn=${this.#dashTurn + 1} localUser=${localUser}`);
    if (this.#turnOpen) return;
    this.#reserveTurn();
    this.#localUserPending = localUser;
    this.session.append("turn/start", { turn: this.#dashTurn });
    this.#emitRequestContext();
    this.session.append("user/message", message, { surfaceOp: "append" });
  }

  #closeTurn(reason: TurnEndReason): void {
    if (!this.#turnOpen) return;
    this.#turnOpen = false;
    this.#localUserPending = false;
    this.session.append("turn/end", { turn: this.#dashTurn, reason });
  }

  /**
   * Append the deferred `step/start` now that the step's first message has
   * revealed which Dash turn owns it (a queued follow-up opens a fresh turn).
   */
  #commitStepStart(): void {
    if (!this.#turnOpen) return;
    // On-demand open: the Codex SDK emits `item.completed` without a preceding
    // `item.started` for plain text turns, so a step must open at the first
    // step-scoped use rather than only on a `message_start` that may never
    // arrive. `#stepStartPending` (set by turn_start) still forces a FRESH
    // step when the runtime opens another turn.
    if (!this.#stepStartPending && this.#step > 0) return;
    this.#stepStartPending = false;
    this.#step += 1;
    this.session.append("step/start", { turn: this.#dashTurn, step: this.#step });
    trace(`step/start turn=${this.#dashTurn} step=${this.#step}`);
  }

  /**
   * Bridge a wire `message_start(role=user)` that was NOT appended locally.
   * A `followUp` echo closes the current Dash turn and opens a fresh one with
   * the retained message (the client queued it and is now generating its
   * turn); a steering/injection echo adds a `user/message` step to the
   * current turn. Falls back to the wire's own content if no retained
   * message matches.
   */
  #bridgeRemoteUser(wireMessage: WireMessage): void {
    const entry = this.#remoteQueue.shift();
    if (entry === undefined) {
      this.#closeTurn({ kind: "completed" });
      this.#openTurn(userMessageFromWire(wireMessage), false);
      return;
    }
    if (entry.transport === "followUp") {
      this.#closeTurn({ kind: "completed" });
      this.#openTurn(entry.message, false);
      return;
    }
    this.session.append("user/message", entry.message, { surfaceOp: "append" });
  }

  #beginActivity(): void {
    // Settle any prior in-flight activity first: `send()` can inject a prompt
    // mid-stream (streamingBehavior followUp/steer), superseding the current
    // activity promise. Without settling the old one, whenIdle()'s do-while
    // would await an orphaned promise that never resolves.
    this.#resolveActivityDone();
    this.#activityDone = new Promise<void>((resolve) => {
      this.#resolveActivityDone = resolve;
    });
  }

  #endActivity(): void {
    this.#resolveActivityDone();
  }

  #markRunning(): void {
    clearTimeout(this.#idleExitTimer);
    this.#idleExitTimer = undefined;
    if (this.#streaming) return;
    this.#streaming = true;
    this.#dispatch.emit("agent/status", { status: "running" });
  }

  #markIdle(): void {
    if (!this.#streaming) return;
    this.#streaming = false;
    this.#dispatch.emit("agent/status", { status: "idle" });
    this.#armIdleExit();
  }

  /**
   * Schedule the idle exit. Skipped while deliveries are still queued (an
   * unanswered parked injection means work is pending, not idle) or when the
   * exit is disabled. Any later activity restarts or cancels the timer.
   */
  #armIdleExit(): void {
    if (this.#disposed || this.#onIdleExit === undefined || CODEX_IDLE_EXIT_MS === 0) return;
    if (this.#remoteQueue.some((entry) => !entry.sent)) return;
    clearTimeout(this.#idleExitTimer);
    this.#idleExitTimer = setTimeout(() => {
      this.#idleExitTimer = undefined;
      void this.#revalidateIdleExit();
    }, CODEX_IDLE_EXIT_MS);
    this.#idleExitTimer.unref?.();
  }

  /**
   * Quiescence re-validation at fire time. The idle timer is only a hint:
   * before teardown, re-confirm no live work via local signals and the
   * client's own self-attestation (get_state streaming). Any busy signal
   * re-arms instead of killing; a query failure fail-softs to the local
   * signals rather than forcing a teardown.
   */
  async #revalidateIdleExit(): Promise<void> {
    if (this.#disposed || this.#streaming) return this.#armIdleExit();
    if (this.#remoteQueue.some((entry) => !entry.sent)) return this.#armIdleExit();
    try {
      const state = await this.#client.getState();
      if (this.#streaming) return this.#armIdleExit();
      if (state.isStreaming) return this.#armIdleExit();
    } catch {
      // Self-attestation unavailable: local signals remain authoritative.
    }
    try {
      const subagents = await this.#client.getSubagents();
      if (this.#streaming) return this.#armIdleExit();
      if (subagents.length > 0) return this.#armIdleExit();
    } catch {
      // getSubagents fail-softs already; belt-and-suspenders.
    }
    if (this.#streaming) return this.#armIdleExit();
    trace(`idle exit after ${CODEX_IDLE_EXIT_MS}ms — disposing agent ${this.id}`);
    this.#onIdleExit?.();
  }

  #fail(error: unknown): void {
    this.#abandonStreamBridge();
    if (this.#disposed) return;
    const classified = classifyNativeFailure(error);
    trace(`#fail [${classified.code}] ${classified.message.slice(0, 200)}`);
    if (classified.code === "ROLLOUT_MISSING" || classified.code === "NATIVE_REJECTED") {
      // The native runtime rejected this session's thread at turn time.
      // Mark the identity map so the next resume fails fast with the stable
      // code instead of burning another turn on a dead rollout (plan RC-4).
      this.#runtimeInfo?.markNotResumable?.();
    }
    // Flush a buffered final assistant (usage-less — the turn failed) so
    // failure paths never drop the turn's visible text.
    this.#flushDeferredAssistant();
    this.#closeTurn({ kind: "error", error: classified });
    this.#markIdle();
    this.#endActivity();
  }

  #handleEvent(event: WireEvent): void {
    switch (event.type) {
      case "agent_start":
        trace("event agent_start");
        this.#markRunning();
        this.#flushRemote();
        break;
      case "turn_start":
        // Defer `step/start`: the step's owning turn is only known once its
        // first message arrives (a queued follow-up opens a fresh turn).
        trace("event turn_start");
        this.#stepStartPending = true;
        this.#pendingFailure = null;
        // Open the step immediately (the SDK may never send message_start)
        // and try the system prompt now that the thread's rollout exists.
        this.#commitStepStart();
        this.#emitSystemMessage();
        break;

      case "message_start": {
        const message = event.message as WireMessage | undefined;
        if (message?.role === "user") {
          if (this.#localUserPending) {
            // The client is echoing the user message #openTurn already appended.
            this.#localUserPending = false;
          } else {
            // A queued follow-up / steering message delivered by the client.
            this.#bridgeRemoteUser(message);
          }
        } else if (message?.role === "assistant") {
          // Reset per-message streaming accumulators.
          this.#abandonStreamBridge();
        }
        // role === "toolResult" is bridged in message_end (deduped vs tool_execution_end).
        this.#commitStepStart();
        // The Codex system prompt is stamped inside the first OPEN step of the
        // first turn (the rollout HEAD only exists once the thread started).
        this.#emitSystemMessage();
        break;
      }

      case "message_update": {
        const delta = event.assistantMessageEvent as WireAssistantMessageEvent | undefined;
        if (delta !== undefined) this.#handleUpdate(delta);
        break;
      }

      case "message_end": {
        const message = event.message as WireMessage | undefined;
        if (message === undefined) break;
        const role = message.role as string;
        if (role === "assistant") {
          const failure = wireFailure(message);
          if (failure !== undefined) {
            this.#pendingFailure = failure;
            this.#abandonStreamBridge();
          } else {
            // Buffer as the turn's final assistant candidate: flushed at
            // `turn_end` with the SAME turn's usage (or earlier on failure).
            this.#deferAssistant(message);
          }
        } else if (role === "toolResult") {
          this.#appendToolResultMessage(message);
        } else if (role !== "user") {
          process.stderr.write(`codex wire: unhandled message_end role "${role}"\n`);
        }
        break;
      }

      case "tool_execution_start": {
        const callId = String(event.toolCallId ?? "");
        const name = String(event.toolName ?? "");
        this.#commitStepStart();
        this.session.append("tool/call", {
          turn: this.#dashTurn,
          step: this.#step,
          callId: ToolCallId(callId),
          name,
          // The DSH payload requires the RAW JSON string the model produced;
          // the wire carries it verbatim for MCP calls and renders it from the
          // discrete fields for the other item shapes.
          arguments: String(event.argumentsJson ?? JSON.stringify(event.args ?? {})),
        });
        break;
      }

      case "tool_execution_end":
        this.#appendToolResult(event);
        break;

      case "todo_write":
        // DSH `todo/write` (log-only, latest-wins whole-list snapshot) —
        // projected by the todo_list tool item alongside its tool pair.
        // The locally-resolved dsh-session build does not declare the
        // tool-todo vocabulary, so the append goes through a narrow cast
        // (same seam as the model/selection append in index.ts).
        // The locally-resolved dsh-session build does not declare the
        // tool-todo vocabulary (no dsh-tool-todo dependency), so the append
        // goes through a narrow cast (same seam as model/selection in index.ts).
        (this.session.append as (type: string, data: unknown) => unknown)("todo/write", {
          todos: Array.isArray(event.todos) ? event.todos : [],
        });
        break;

      case "turn_end":
        trace("event turn_end");
        // Last chance for the system prompt: by now the thread's rollout HEAD
        // exists for certain. Appended inside the still-open step (before
        // step/end) so the step-scope invariant holds; a no-op once stamped.
        this.#emitSystemMessage();
        // Land THIS turn's usage on the turn's final assistant message — the
        // DSH turn-token fold requires the sample on a message of the SAME
        // turn. Flushed inside the still-open step, BEFORE step/end.
        this.#flushDeferredAssistant(convertUsage((event.data as { usage?: unknown } | undefined)?.usage));
        if (this.#turnOpen && this.#step > 0) {
          this.session.append("step/end", { turn: this.#dashTurn, step: this.#step });
        }
        break;

      case "agent_end": {
        trace(`event agent_end cancelCause=${String(this.#cancelCause)}`);
        const pendingFailure = this.#pendingFailure;
        this.#pendingFailure = null;
        // Backstop flush: aborted/failed turns never saw `turn_end`, so the
        // buffered final assistant flushes here (usage-less) and the visible
        // text survives — the pre-deferral behavior, re-ordered.
        this.#flushDeferredAssistant();
        this.#closeTurn(
          this.#cancelCause !== null
            ? { kind: "aborted", reason: this.#cancelCause }
            : pendingFailure !== null
              ? { kind: "error", error: pendingFailure }
              : { kind: "completed" },
        );
        this.#cancelCause = null;
        this.#markIdle();
        this.#endActivity();
        // Live metadata the Dash surface has no projection seam for yet:
        // surface the client's own accounting in the diagnostic trace so it
        // is observable per completed turn.
        void this.#client
          .getSessionStats()
          .then((stats) => {
            trace(`sessionStats tokens=${JSON.stringify(stats.tokens ?? {})}`);
          })
          .catch(() => { });

        break;
      }
    }
  }

  /** The open stream bridge for this message, starting one on first use. */
  #ensureStreamBridge(): AssistantStreamBridge {
    if (this.#streamBridge === undefined || this.#streamBridge.ended) {
      this.#streamBridge = new AssistantStreamBridge(
        this.session.id,
        ++this.#assistantAttemptCounter,
        () => ++this.#assistantStreamRevision,
        (frame) => this.#dispatch.emit("agent/assistant-stream", { frame }),
      );
      this.#streamBridge.start(this.#dashTurn, this.#step);
    }
    return this.#streamBridge;
  }

  /** Abandon any open stream bridge — failure paths never settle. */
  #abandonStreamBridge(): void {
    if (this.#streamBridge !== undefined && !this.#streamBridge.ended) this.#streamBridge.abandon();
    this.#streamBridge = undefined;
  }

  #handleUpdate(delta: WireAssistantMessageEvent): void {
    switch (delta.type) {
      case "text_delta":
        if (typeof delta.delta === "string" && delta.delta !== "") {
          const chunk: StreamChunk = { type: "text-delta", index: delta.contentIndex ?? 0, text: delta.delta };
          // v2: live text no longer appends `assistant/chunk` log events — the
          // stream publishes as dense agent frames and embeds durably in the
          // final assistant/message.
          this.#ensureStreamBridge().push(chunk);
        }
        break;
      default:
        // thinking_*/toolcall_* are folded into the final message.
        break;
    }
  }

  /**
   * Buffer the turn's final assistant message. An already-buffered message is
   * flushed first (usage-less — it belonged to an earlier codex turn of the
   * same Dash turn), so the buffer always holds the LATEST candidate.
   */
  #deferAssistant(message: WireMessage): void {
    this.#flushDeferredAssistant();
    this.#deferredAssistant = message;
  }

  /** Append the deferred final assistant message (with `usage` when known); no-op when empty. */
  #flushDeferredAssistant(usage?: TokenUsage): void {
    const message = this.#deferredAssistant;
    if (message === null) return;
    this.#deferredAssistant = null;
    this.#appendAssistantMessage(message, usage);
  }

  #appendAssistantMessage(message: WireMessage, usage?: TokenUsage): void {
    const content = convertContent(message.content);
    const assistant: AssistantMessage = createAssistantMessage({
      content,
      source: {
        // Rollout/wire messages may carry no attribution: fall back to this
        // agent's options (the omp bridge did the same).
        provider: String(message.provider ?? this.options.provider ?? ""),
        model: String(message.model ?? this.options.model ?? ""),
      },
    });
    const bridge = this.#streamBridge;
    this.#commitStepStart();
    // v2: the attempt's timed chunks embed in the event itself;
    // `sourceEventSeqs` is forbidden on assistant/message in v2.
    const event = this.session.append("assistant/message", {
      turn: this.#dashTurn,
      step: this.#step,
      message: assistant,
      stream: bridge?.records ?? [],
      ...(usage === undefined ? {} : { usage }),
    }, {
      surfaceOp: "append",
    });
    if (bridge !== undefined && !bridge.ended) bridge.settle(event.seq);
    this.#streamBridge = undefined;
  }

  #appendToolResult(event: WireEvent): void {
    const callId = String(event.toolCallId ?? "");
    this.#bridgedToolResults.add(callId);
    const result = event.result as { content?: WireContentBlock[]; isError?: boolean } | undefined;
    const isError = Boolean(event.isError ?? result?.isError ?? false);
    const message = createToolResultMessage({
      callId: ToolCallId(callId),
      content: convertContent(result?.content),
      isError,
    });
    this.session.append("tool/result", {
      turn: this.#dashTurn,
      step: this.#step,
      message,
      ...(isError ? { error: { name: "ToolExecutionError", code: "TOOL_ERROR" } } : {}),
    }, {
      surfaceOp: "append",
    });
  }

  #appendToolResultMessage(message: WireMessage): void {
    const callId = String(message.toolCallId ?? "");
    // The normal path bridges via `tool_execution_end` first; skip the
    // `message_end(toolResult)` duplicate the wire always also emits.
    if (this.#bridgedToolResults.has(callId)) return;
    this.#bridgedToolResults.add(callId);
    const isError = Boolean(message.isError ?? false);
    const result = createToolResultMessage({
      callId: ToolCallId(callId),
      content: convertContent(message.content),
      isError,
    });
    this.session.append("tool/result", {
      turn: this.#dashTurn,
      step: this.#step,
      message: result,
      ...(isError ? { error: { name: "ToolExecutionError", code: "TOOL_ERROR" } } : {}),
    }, {
      surfaceOp: "append",
    });
  }
}
