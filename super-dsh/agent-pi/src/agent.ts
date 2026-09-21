/**
 * PiAgent — the Dash `Agent` shim over one `PiSessionClient` (a pi
 * `AgentSession` driven in-process through the SDK).
 *
 * Bridges pi's wire event stream (projected by pi-events.ts) into the Dash
 * `SessionEventMap`:
 *
 *   pi wire                           →  Dash session event
 *   ─────────────────────────────────────────────────────────────
 *   (send/followup delivers)          →  turn/start + user/message
 *   turn_start                        →  step/start
 *   message_update(text_delta)        →  (v2 stream frame, no log event)
 *   message_end(assistant)            →  assistant/message (+ usage, reasoning)
 *   message_end(toolResult)           →  tool/result (deduped vs tool_execution_end)
 *   tool_execution_start              →  tool/call
 *   tool_execution_end                →  tool/result
 *   turn_end                          →  step/end
 *   agent_end                         →  turn/end + status idle
 *   session_info_changed              →  session/title (pi owns titles)
 *   compaction_start|end              →  compaction/start|end (pi compaction is real)
 *
 * One Dash turn (user prompt → final answer) spans multiple pi turns (one
 * assistant response + its tool executions each), so Dash turn/step
 * boundaries are synthesized around the wire stream. The event `type`
 * strings are IDENTICAL to the omp/codex bridges — this is the same switch,
 * with the SDK-line cuts applied: no approval cards (pi has no per-action
 * approval channel; the preset is a launch-only toolset), no supervisor.
 *
 * Token usage: pi reports usage on every assistant message — the Dash log
 * carries it on the SAME assistant/message (an upgrade over the codex line's
 * one-turn lag).
 */
// Session event keys this adapter appends that the locally-resolved
// dsh-session build does not declare (upstream owns them in
// dsh-agent-presets / dsh-session-controller / dsh-session-title). Mirrored
// from upstream payload shapes so `SessionEvent` narrows.
declare module "@deepseek-ai/dsh-session/types" {
  interface SessionEventMap {
    "agent-preset/selected": { agentPreset: string };
    "compaction/start": { compactionId: string; sourceCommandId?: string; turn?: number | null; error?: string };
    "compaction/end": { compactionId: string; sourceCommandId?: string; turn?: number | null };
    "session/title": { title: string; messageSeqs: number[]; source: { kind: string; provider?: string; reason?: string } };
  }
}
import { randomUUID } from "node:crypto";
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
import type { WireAssistantMessageEvent, WireContentBlock, WireEvent, WireMessage } from "./pi-events.js";
import type { PiSessionClient } from "./pi-client.js";
import { PI_IDLE_EXIT_MS } from "./knobs.js";
import { trace } from "./knobs.js";
// Type-only: pulls dsh-commands' `Context.commands` augmentation into this
// compilation (the runtime service is mounted by the base bundle).
import type { CommandInvocation, CommandResult } from "@deepseek-ai/dsh-commands";
import { PI_PROVIDER_ID, splitCatalogId } from "./models.js";

/**
 * v2 live assistant-stream publication for the pi bridge — the same frame
 * protocol the reference loop's AssistantStreamAttempt speaks (start marker,
 * dense zero-based chunks, terminal settlement) emitted over this agent's own
 * dispatch, so the session-controller folds pi's stream into its reconnect
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
 * `failure` (`{ message, code }`). Same taxonomy as the codex bridge — quota
 * wording is checked before the generic 403→AUTH because some providers
 * report an exhausted billing quota as HTTP 403.
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
 * Map pi's camelCase `Usage` record into Dash `TokenUsage`.
 */
export function convertUsage(usage: unknown): TokenUsage | undefined {
  if (usage === null || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const inputTokens = typeof u.input === "number" ? u.input : 0;
  const outputTokens = typeof u.output === "number" ? u.output : 0;
  if (inputTokens === 0 && outputTokens === 0) return undefined;
  const result: TokenUsage = { inputTokens, outputTokens };
  if (typeof u.cacheRead === "number") result.cacheReadTokens = u.cacheRead;
  if (typeof u.cacheWrite === "number") result.cacheWriteTokens = u.cacheWrite;
  if (typeof u.reasoning === "number") result.reasoningTokens = u.reasoning;
  return result;
}

/** Join the visible text blocks of a Dash user message into the pi prompt string. */
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
 * approval policy. pi has no runtime approval control either (the preset is a
 * launch-only toolset), so forwarding the text would steer it into an
 * in-flight turn and echo it into history as a fake user prompt. Detect and
 * drop it.
 */
function isApprovalNarration(message: UserMessage): boolean {
  const source = message.source;
  return source.kind === "plugin" && source.plugin === "user-approval";
}

/**
 * Reconstruct a Dash user message from a wire `message_start(role=user)`
 * payload. Defensive fallback when a queued delivery's retained message is
 * missing (the client echoes text, so the visible content is preserved).
 */
function userMessageFromWire(message: WireMessage): UserMessage {
  return createUserMessage({
    content: convertContent(message.content).filter((block) => block.type === "text"),
    source: { kind: "user" },
  });
}

/**
 * The slice of `ctx.agentDefaultModel` the model-sync path reads. Typed
 * locally so the agent needs no dependency on the dsh-agent-default-model
 * package.
 */
interface AgentDefaultModelSlice {
  currentSelection(): { provider: string; model: string };
}

/**
 * Adapter-owned runtime facts the agent stamps into the session log: pi's own
 * system prompt (live on the SDK session once started) and the effective
 * route metadata (selected pi model, else the catalog default, plus the
 * model's context window).
 */
export interface PiAgentRuntimeInfo {
  /** pi's own system prompt for this session, when the session is started. */
  systemPrompt(): string | undefined;
  /**
   * The effective pi route for this session: the session's preferred
   * selection (provider slug + bare model id — legacy composites are split
   * by the resolver) wins, else the catalog default. Returns `undefined`
   * when neither is known.
   */
  routeContext(preferred: { provider?: string; model?: string } | undefined): { provider: string; model: string; contextWindow?: number } | undefined;
}

export class PiAgent implements Agent {
  readonly id: SessionId;
  readonly options: AgentOptions;
  readonly session: Session;
  readonly inbox: Inbox;
  readonly ctx: Context;
  readonly #client: PiSessionClient;
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
   * Deliveries forwarded through the client, in submission order. The client
   * echoes each as `message_start(role=user)`; the bridge maps it by
   * transport: a `followUp` echo closes the current Dash turn and opens a
   * fresh one, a `steer` echo appends a `user/message` step to the current
   * turn. `sent` marks entries already dispatched to the client.
   */
  #remoteQueue: { message: UserMessage; sent: boolean; transport: "followUp" | "steer" }[] = [];
  #bridgedToolResults = new Set<string>();
  /** The last title already mirrored into the log (dedupe). */
  #mirroredTitle: string | null = null;
  /** The open compaction lifecycle's id (`compaction/start` … `compaction/end`). */
  #compactionId: string | null = null;
  /** The last selection already synced to the client via set_model, as `provider/model`. */
  #lastSyncedModel: string | null = null;
  /** Fires when the agent has been idle past PI_IDLE_EXIT_MS (tears down the client). */
  readonly #onIdleExit: (() => void) | undefined;
  #idleExitTimer: NodeJS.Timeout | undefined = undefined;
  #disposed = false;
  /** One-shot guard for the first-turn session-identity commit (#bootstrapSessionIdentity). */
  #sessionIdentityCommitted = false;
  /** Adapter-owned runtime facts (system prompt / route metadata), when supplied. */
  readonly #runtimeInfo: PiAgentRuntimeInfo | undefined;
  /** One-shot guard for the `system/message` surface node (never re-emitted). */
  #systemMessageDone = false;
  /** Last `request/context` route key (`provider/model`) — dedupes per-turn emits. */
  #lastRouteKey: string | null = null;

  constructor(loopCtx: Context, id: SessionId, options: AgentOptions, session: Session, client: PiSessionClient, onIdleExit?: () => void, runtimeInfo?: PiAgentRuntimeInfo) {
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
    // Session-identity events are committed on the FIRST turn (only once the
    // client actually exists), so a freshly created session announces
    // completely blank — the backend takes zero part in the UI's new-session
    // draft.
    //
    // `/permission` cannot work here: pi has no runtime approval control (the
    // preset is realized as a launch-only toolset). Registering the SAME name
    // on this agent's own scope SHADOWS the global permission command for
    // this agent only — the switch fails cleanly instead of appending
    // approval/policy events pi cannot honor. (The `inject` narration drop
    // below stays as the backstop.)
    this.ctx.inject(["commands"], (cmdCtx) =>
      cmdCtx.commands.register({
        name: "permission",
        description: "Unavailable for pi sessions (the toolset is fixed at session start)",
        input: { hint: "<preset>" },
        handler: () => ({
          kind: "error" as const,
          text: "The pi toolset is fixed at session start; runtime switching is not supported for pi sessions.",
        }),
      }),
    );
    // `/compact` parity: pi compaction is REAL and wired (compaction_start/
    // compaction_end bridge into the DSH log). Shadows the (disabled) native
    // pipeline so the command drives the pi session's own compaction.
    this.ctx.inject(["commands"], (cmdCtx) =>
      cmdCtx.commands.register({
        name: "compact",
        description: "Compact this pi session's context",
        input: { hint: "[instructions]" },
        handler: (invocation: CommandInvocation): CommandResult => {
          void this.#client.compact(invocation.rawInput.trim() === "" ? undefined : invocation.rawInput).catch(() => { });
          return { kind: "success" as const, text: "Compaction started." };
        },
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
    // queue (pi delivers it as the next turn's user message). Mirrors
    // dsh-agent-loop's `followup = send(input, "next-turn", true)`.
    this.#deliver(message, "next-turn", true);
  }

  steer(message: UserMessage): void {
    // Mirrors dsh-agent-loop's `steer = send(input, "next-step", true)`: an
    // idle driver starts a turn; a running driver consumes it at the next
    // step (pi steers natively — delivered after the in-flight turn's tool
    // calls, before the next LLM call).
    this.#deliver(message, "next-step", true);
  }

  inject(message: UserMessage): void {
    // Dash-host approval-policy narrations have no pi runtime equivalent.
    // Forwarding the text would steer it into an in-flight turn and echo it
    // into history as a fake user prompt. Drop it; the accompanying
    // `approval/policy` session event stays recorded so the UI's permission
    // state remains truthful.
    if (isApprovalNarration(message)) {
      trace("inject: dropped approval-policy narration (pi lacks runtime approval control)");
      return;
    }
    // Mirrors dsh-agent-loop's `inject = send(input, "next-step", false)`:
    // queued without waking; idle drivers leave it pending until a later
    // follow-up/steer wakes them (flushed at the next agent_start).
    this.#deliver(message, "next-step", false);
  }

  cancel(cause: AgentCancelCause, _options?: CancelOptions): void {
    // No active run → no-op: arming `#cancelCause` here would misreport a
    // later, unrelated completed turn as aborted. First cause wins.
    if (!this.#streaming) return;
    if (this.#cancelCause === null) this.#cancelCause = cause;
    void this.#client.abort().catch(() => { });
  }

  async whenIdle(): Promise<void> {
    // Event-driven: wait for the current activity to settle (agent_end), then
    // confirm the client reports quiescence.
    let activity: Promise<void>;
    do {
      activity = this.#activityDone;
      await activity;
    } while (activity !== this.#activityDone);
    for (; ;) {
      const state = this.#client.getState();
      if (!state.isStreaming) return;
      await delay(50);
    }
  }

  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    // pi has no maintenance concept; run the task directly.
    return task(new AbortController().signal);
  }

  /** Stop the pi session and unwind the scoped world. Idempotent. */
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
   * sent while a turn is open is forwarded to the client's queue
   * (`followUp`); steering/injection goes through `steer` (consumed at the
   * next step, or parked until agent_start when not yet streaming).
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
    // Reserve the turn synchronously, but NOTHING is appended yet — the log
    // stays empty until the client exists, so a failed cold start leaves no
    // orphan turn.
    this.#reserveTurn();
    clearTimeout(this.#idleExitTimer);
    this.#idleExitTimer = undefined;
    this.#beginActivity();
    void this.#startTurn(message);
  }

  /**
   * Cold-start path for one reserved turn: start the session (lazy boundary —
   * pi's native session file materializes HERE), commit the session-identity
   * events ahead of the turn, sync the model, then append turn/start +
   * user/message and dispatch. A failed cold start synthesizes the failed
   * turn so the UI's error path renders it, then unwinds the reservation.
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
   * Stamp pi's system prompt once per session as the step's surface node.
   * `system/message` is a step-scoped surface event, so this runs only after
   * `step/start` committed. Skips when the log already carries one (resume),
   * when there is no runtime bridge, and while the session has not started —
   * retried on later steps until the text is available.
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
        message: createSystemMessage(text, "aw.agent-adapter-pi"),
      },
      { surfaceOp: "append" },
    );
    this.#systemMessageDone = true;
    trace(`system/message stamped (${text.length} chars)`);
  }

  /**
   * Stamp route metadata for the next request (`request/context`): the
   * effective provider/model plus the model's context window when known.
   * Turn-enclosed (no step required) and deduped by route key.
   */
  #emitRequestContext(): void {
    if (this.#runtimeInfo === undefined || !this.#turnOpen) return;
    const route = this.#runtimeInfo.routeContext(this.options);
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
   */
  async #bootstrapSessionIdentity(): Promise<void> {
    if (this.#sessionIdentityCommitted) return;
    this.#sessionIdentityCommitted = true;
    if (!this.session.snapshotEvents().some((event) => event.type === "agent-preset/selected" && event.data?.agentPreset === "pi")) {
      this.session.append("agent-preset/selected", { agentPreset: "pi" });
    }
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
   * dispatched. Waterfall: the session's logged `request/header` route, then
   * the global `agentDefaultModel` selection, then the agent options. The
   * chosen pair threads to the client as (provider slug, bare model id) —
   * exactly what the shared runtime's `getModel` takes. A LEGACY stored
   * selection still arrives as the umbrella `pi` route with a composite
   * `<provider>/<modelId>` model; splitCatalogId (its only remaining job)
   * resolves that shape here, before the runtime lookup. pi's setModel is
   * LIVE (an upgrade over the codex SDK line's next-turn switch).
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
    // Legacy composites (`<provider>/<modelId>` under the umbrella route)
    // split into the real pair; real-slug pairs pass through untouched (a
    // bare id may itself contain slashes — the FIRST-slash split of the
    // composite `<provider>/<bare>` reproduces exactly that pair).
    const legacy = target.provider === "" || target.provider === PI_PROVIDER_ID ? splitCatalogId(target.model) : undefined;
    const route = legacy ?? { provider: target.provider, modelId: target.model };
    if (route.provider === "" || route.modelId === "") return;
    const key = `${route.provider}/${route.modelId}`;
    if (key === this.#lastSyncedModel) return;
    await this.#client.setModel(route.provider, route.modelId).catch((error) => {
      trace(`set_model ${key} failed: ${String(error)}`);
    });
    this.#lastSyncedModel = key;
  }

  /**
   * Reserve a turn WITHOUT appending anything: the prompt path reserves
   * synchronously, then commits turn/start + user/message only after the
   * cold start (#startTurn).
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
    if (!this.#stepStartPending && this.#step > 0) return;
    this.#stepStartPending = false;
    this.#step += 1;
    this.session.append("step/start", { turn: this.#dashTurn, step: this.#step });
    trace(`step/start turn=${this.#dashTurn} step=${this.#step}`);
  }

  /**
   * Bridge a wire `message_start(role=user)` that was NOT appended locally.
   * A `followUp` echo closes the current Dash turn and opens a fresh one with
   * the retained message; a steering/injection echo adds a `user/message`
   * step to the current turn. Falls back to the wire's own content if no
   * retained message matches.
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
    // mid-stream, superseding the current activity promise. Without settling
    // the old one, whenIdle()'s do-while would await an orphaned promise.
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
   * Schedule the idle exit. Skipped while deliveries are still queued or
   * when the exit is disabled. Any later activity restarts or cancels it.
   */
  #armIdleExit(): void {
    if (this.#disposed || this.#onIdleExit === undefined || PI_IDLE_EXIT_MS === 0) return;
    if (this.#remoteQueue.some((entry) => !entry.sent)) return;
    clearTimeout(this.#idleExitTimer);
    this.#idleExitTimer = setTimeout(() => {
      this.#idleExitTimer = undefined;
      void this.#revalidateIdleExit();
    }, PI_IDLE_EXIT_MS);
    this.#idleExitTimer.unref?.();
  }

  /**
   * Quiescence re-validation at fire time: local signals plus the client's
   * own attestation. Any busy signal re-arms instead of killing.
   */
  async #revalidateIdleExit(): Promise<void> {
    if (this.#disposed || this.#streaming) return this.#armIdleExit();
    if (this.#remoteQueue.some((entry) => !entry.sent)) return this.#armIdleExit();
    try {
      const state = this.#client.getState();
      if (this.#streaming) return this.#armIdleExit();
      if (state.isStreaming) return this.#armIdleExit();
    } catch {
      // Closed client: local signals remain authoritative.
    }
    trace(`idle exit after ${PI_IDLE_EXIT_MS}ms — disposing agent ${this.id}`);
    this.#onIdleExit?.();
  }

  #fail(error: unknown): void {
    this.#abandonStreamBridge();
    if (this.#disposed) return;
    trace(`#fail ${String(error).slice(0, 200)}`);
    this.#closeTurn({ kind: "error", error: { message: String(error), code: "UNKNOWN" } });
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
        // Open the step immediately (pi may never send message_start)
        // and try the system prompt now that the session exists.
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
        // pi's system prompt is stamped inside the first OPEN step of the
        // first turn (the SDK session only exposes it once started).
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
            this.#appendAssistantMessage(message);
          }
        } else if (role === "toolResult") {
          this.#appendToolResultMessage(message);
        } else if (role !== "user") {
          process.stderr.write(`pi wire: unhandled message_end role "${role}"\n`);
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
          // the projection stringified pi's parsed args object.
          arguments: typeof event.args === "string" ? event.args : JSON.stringify(event.args ?? {}),
        });
        break;
      }

      case "tool_execution_end":
        this.#appendToolResult(event);
        break;

      case "turn_end":
        trace("event turn_end");
        // Last chance for the system prompt. Appended inside the still-open
        // step (before step/end) so the step-scope invariant holds.
        this.#emitSystemMessage();
        if (this.#turnOpen && this.#step > 0) {
          this.session.append("step/end", { turn: this.#dashTurn, step: this.#step });
        }
        break;

      case "agent_end": {
        trace(`event agent_end cancelCause=${String(this.#cancelCause)}`);
        const pendingFailure = this.#pendingFailure;
        this.#pendingFailure = null;
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
        break;
      }

      case "session_title":
        this.#mirrorTitle(event.name);
        break;

      case "compaction_start":
        this.#openCompaction();
        break;

      case "compaction_end":
        this.#closeCompaction();
        break;
    }
  }

  /**
   * Mirror pi's session title into a `session/title` event. Dash does not
   * generate titles for pi sessions (the native title rows are disabled in
   * the bundle patch); pi owns the title and reports it through
   * `session_info_changed`. Empty or unchanged titles are ignored, and a
   * title is never allowed to affect the turn.
   */
  #mirrorTitle(name: string | undefined): void {
    if (name === undefined || name.trim() === "" || name === this.#mirroredTitle) return;
    this.#mirroredTitle = name;
    try {
      (this.session.append as (type: string, data: unknown) => unknown)("session/title", {
        title: name,
        messageSeqs: [],
        source: { kind: "provider", provider: "pi" },
      });
      trace(`session/title ← pi: "${name}"`);
    } catch {
      // fail-soft: a title never affects the turn
    }
  }

  /** Open the compaction lifecycle bracket in the DSH log. */
  #openCompaction(): void {
    if (this.#compactionId !== null) return;
    const compactionId = randomUUID();
    this.#compactionId = compactionId;
    try {
      this.session.append("compaction/start", { compactionId });
      trace(`compaction/start ${compactionId}`);
    } catch {
      this.#compactionId = null;
    }
  }

  /** Close the compaction lifecycle bracket (fail-soft, never throws). */
  #closeCompaction(): void {
    const compactionId = this.#compactionId;
    if (compactionId === null) return;
    this.#compactionId = null;
    try {
      this.session.append("compaction/end", { compactionId });
      trace(`compaction/end ${compactionId}`);
    } catch {
      // fail-soft
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

  #appendAssistantMessage(message: WireMessage): void {
    const content = convertContent(message.content);
    // pi reports usage on every assistant message — same-event attachment,
    // no lag.
    const usage = convertUsage(message.usage);
    const assistant: AssistantMessage = createAssistantMessage({
      content,
      source: {
        // Wire messages may carry no attribution: fall back to this agent's
        // options (the omp bridge did the same).
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

  #appendToolResult(event: Extract<WireEvent, { type: "tool_execution_end" }>): void {
    const callId = String(event.toolCallId ?? "");
    this.#bridgedToolResults.add(callId);
    const isError = event.isError === true;
    const message = createToolResultMessage({
      callId: ToolCallId(callId),
      content: convertContent(event.result?.content),
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

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
