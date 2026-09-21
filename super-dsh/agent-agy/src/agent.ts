/**
 * AgyAgent — the Dash `Agent` shim over one `AgyBridgeClient` (the Python SDK
 * bridge child; localharness materializes inside it on the first prompt).
 *
 * Projection (bridge → Dash session events):
 *   (prompt delivery)   → turn/start + user/message
 *   chunk (streamed)    → assistant stream frames (v2 protocol) accumulated
 *                         as durable records; the FULL text commits once as
 *                         assistant/message at `done`
 *   tool                → (V1: bridge supplies name only — omitted from the
 *                         log rather than fabricated; event-stream honesty)
 *   done                → assistant/message + step/end + turn/end {completed}
 *   error               → turn/end {error} with a stable code
 *
 * Bridge gaps registered explicitly (never fabricated):
 * - token usage: the bridge `done` event carries none → no usage field.
 * - tool fidelity: only a tool name arrives (no call id / args / result) → no
 *   tool/call or tool/result events in V1.
 * - steer/cancel: the bridge has no in-turn interrupt; `steer` degrades to a
 *   parked follow-up, `cancel` records the cause (applied at the terminal).
 *
 * Onboarding (§17 minimal, consumer-first): when no Gemini API key is known,
 * the first user turn never touches the bridge — the turn is answered locally
 * with a system/message asking for the key; a pasted key is persisted through
 * `onApiKey` (adapter state, world home only) and confirmed in the same turn.
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
import type { AgentCancelCause, Session, SessionId, SessionSeq, TurnEndReason, UserMessage } from "@deepseek-ai/dsh-session";
import type { AssistantMessage, AssistantStreamRecord, ContentBlock, StreamChunk, TokenUsage } from "@deepseek-ai/dsh-llm";
import { LlmAttemptId, ToolCallId, createAssistantMessage, createSystemMessage, createToolResultMessage } from "@deepseek-ai/dsh-llm";
import { createScope, type Scope } from "@deepseek-ai/dsh-scope";
import type { AgyBridgeClient } from "./agy-client.js";
import type { AgyCliClient } from "./agy-cli-client.js";

/** Structural union of the two live transports (SDK bridge | CLI stream). */
export type LiveAgyClient = Pick<
  AgyBridgeClient,
  "conversationId" | "lastUsage" | "onThinkingDelta" | "onToolEvent" | "setApprovalHandler" | "turn" | "close"
> & { setSystemMessageHandler?(handler: (text: string) => void): void };

/** v2 live assistant-stream publication (same frame protocol as hermes). */
class AssistantStreamBridge {
  readonly attemptId: LlmAttemptId;
  readonly records: AssistantStreamRecord[] = [];
  private readonly nextRevision: () => number;
  private readonly emit: (frame: AssistantStreamFrame) => void;
  private index = 0;
  private terminal = false;

  constructor(sessionId: SessionId, attempt: number, nextRevision: () => number, emit: (frame: AssistantStreamFrame) => void) {
    this.attemptId = LlmAttemptId(`${sessionId}:${attempt}`);
    this.nextRevision = nextRevision;
    this.emit = emit;
  }

  get ended(): boolean {
    return this.terminal;
  }

  start(turn: number, step: number): void {
    this.emit({ type: "start", attemptId: this.attemptId, revision: this.nextRevision(), turn, step });
  }

  push(chunk: StreamChunk): void {
    const time = Date.now();
    this.records.push({ type: "chunk", time, chunk });
    this.emit({ type: "chunk", attemptId: this.attemptId, revision: this.nextRevision(), index: this.index++, time, chunk });
  }

  settle(seq: SessionSeq): void {
    this.terminal = true;
    this.emit({ type: "end", attemptId: this.attemptId, revision: this.nextRevision(), index: this.index, outcome: { kind: "committed", eventType: "assistant/message", seq } });
  }

  abandon(): void {
    this.terminal = true;
    this.emit({ type: "end", attemptId: this.attemptId, revision: this.nextRevision(), index: this.index, outcome: { kind: "abandoned" } });
  }
}

const TRACE = process.env.AGY_TRACE === "1";
const trace = (...parts: unknown[]): void => {
  if (TRACE) process.stderr.write(`[agy-agent ${Date.now() % 1_000_000}] ${parts.join(" ")}\n`);
};

/** Classify a bridge turn failure into the stable {message, code} UI chip. */
export function classifyTurnError(error: unknown): { message: string; code: string } {
  const text = error instanceof Error ? error.message : String(error);
  if (/429|prepayment|quota|rate limit/i.test(text)) return { message: text, code: "QUOTA" };
  if (/api key|authentication|unauthenticated|API_KEY/i.test(text)) return { message: text, code: "AUTH" };
  if (/bridge exited/.test(text)) return { message: text, code: "BRIDGE_CRASH" };
  return { message: text, code: "UNKNOWN" };
}

/** Join the visible text blocks of a Dash user message into the prompt string. */
export function userMessageText(message: UserMessage): string {
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text") parts.push(block.text);
  }
  return parts.join("\n");
}

/** Whether a raw user text looks like a pasteable Gemini API key. */
export function looksLikeApiKey(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 20 && !/\s/.test(trimmed);
}

/** Runtime facts the provider stamps the agent with (mirrors hermes). */
export interface AgyAgentRuntimeInfo {
  /** Session materialization context for the bridge (first prompt). */
  readonly session: { cwd: string };
  /** True when no Gemini API key is known: turns are answered locally. */
  readonly awaitingKey: boolean;
  /** Persist a pasted key (adapter state, world home ONLY). */
  readonly onSaveApiKey: (key: string) => void;
  /** Fired after each bridge turn completes (the provider upserts the conversation id). */
  readonly onTurnDone?: () => void;
}

const AGY_TURN_DEADLINE_MS = (() => {
  const raw = process.env.AGY_TURN_DEADLINE_MS;
  if (raw === undefined || raw.trim() === "") return 600_000;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : 600_000;
})();

const ONBOARDING_PROMPT =
  "未检测到 Gemini API key。请粘贴你的 Gemini API key（在 https://aistudio.google.com/apikey 免费获取），我会保存后开始会话。";

export class AgyAgent implements Agent {
  readonly id: SessionId;
  readonly options: AgentOptions;
  readonly session: Session;
  readonly inbox: Inbox;
  readonly ctx: Context;
  private readonly client: LiveAgyClient;
  private readonly loopCtx: Context;
  private readonly scope: Scope;
  private readonly dispatch: AgentEventDispatch;
  private readonly runtimeInfo: AgyAgentRuntimeInfo | undefined;

  private streaming = false;
  private dashTurn = 0;
  private step = 0;
  private lastTurn = 0;
  private turnOpen = false;
  private cancelCause: AgentCancelCause | null = null;
  private streamBridge: AssistantStreamBridge | undefined;
  private assistantAttemptCounter = 0;
  private assistantStreamRevision = 0;
  private remoteQueue: { message: UserMessage; sent: boolean }[] = [];
  private turnDeadlineTimer: NodeJS.Timeout | undefined = undefined;
  private disposed = false;
  private systemMessageDone = false;
  private activityDone: Promise<void> = Promise.resolve();
  private resolveActivityDone: () => void = () => {};
  private readonly onIdleExit: (() => void) | undefined;

  constructor(loopCtx: Context, id: SessionId, options: AgentOptions, session: Session, client: LiveAgyClient, onIdleExit?: () => void, runtimeInfo?: AgyAgentRuntimeInfo) {
    this.loopCtx = loopCtx;
    this.id = id;
    this.options = options;
    this.session = session;
    this.client = client;
    this.onIdleExit = onIdleExit;
    this.runtimeInfo = runtimeInfo;
    this.dispatch = agentEvents(loopCtx, this);
    this.inbox = new Inbox();
    this.scope = createScope(loopCtx, this);
    this.ctx = this.scope.ctx.extend({ agent: this });
    this.lastTurn = session.snapshotEvents().findLast((event) => event.type === "turn/start")?.data.turn ?? 0;
    // Thinking-delta sink: the client forwards Thought deltas here; the turn
    // loop buffers them into the assistant reasoning block.
    this.client.onThinkingDelta = (text: string) => {
      this.pendingThinking.push(text);
    };
    // Tool lifecycle sink: tool_call closes the assistant step and opens a
    // step-scoped tool/call; tool_result appends the paired result (§11).
    this.client.onToolEvent = (ev) => {
      if (!this.turnOpen) return;
      if (ev.event === "tool_call") {
        if (this.step > 0) this.closeStep();
        this.commitStepStart();
        const callId = ToolCallId(ev.id || `agy-${this.dashTurn}-${this.step}`);
        this.session.append("tool/call", {
          turn: this.dashTurn, step: this.step,
          callId, name: ev.name, arguments: ev.args || "{}",
        });
        this.unpairedCalls.push({ callId, name: ev.name });
      } else {
        // ToolResult chunks: the SDK yields none today; if a future version
        // does, pair them off immediately so no placeholder is written.
        this.unpairedCalls = this.unpairedCalls.filter((c) => c.callId !== (ev.id || ""));
        this.session.append("tool/result", {
          turn: this.dashTurn, step: this.step,
          message: createToolResultMessage({
            callId: ToolCallId(ev.id || "unknown"),
            content: [{ type: "text", text: ev.result || "" }],
            isError: ev.is_error,
          }),
          ...(ev.is_error ? { error: { name: "ToolExecutionError", code: "TOOL_ERROR" } } : {}),
        }, { surfaceOp: "append" });
      }
    };
    // Ask-mode tool approvals (hermes #handleApproval shape): the client only
    // consults this when its start frame said approval_mode="ask"; the handler
    // fails closed (no service / error / timeout → deny).
    this.client.setApprovalHandler(async (req) => {
      const approval = this.loopCtx.get("approval") as
        | {
          request(args: {
            agent: Agent;
            toolName: string;
            reason?: string;
            signal?: AbortSignal;
          }): Promise<unknown>;
        }
        | undefined;
      if (approval === undefined) {
        trace("approval: no approval service — deny (fail closed)");
        return false;
      }
      const controller = new AbortController();
      try {
        const outcome = await raceApproval(
          approval.request({
            agent: this as unknown as Agent,
            toolName: req.tool,
            reason: `Antigravity tool call: ${req.args.slice(0, 200)}`,
            signal: controller.signal,
          }),
          controller,
          AGY_APPROVAL_TIMEOUT_MS,
        );
        // Dash approval outcomes: "allowed-once" / "allowed-always" → allow;
        // everything else (denied / dismissed / unknown) → deny.
        return outcome === "allowed-once" || outcome === "allowed-always";
      } catch {
        trace(`approval: ${req.tool} request failed — deny (fail closed)`);
        return false;
      }
    });
  }

  get status(): AgentStatus {
    return this.streaming ? "running" : "idle";
  }

  send(message: UserMessage, _target: InboxTarget, wakeup: boolean): void {
    this.deliver(message, wakeup);
  }

  followup(message: UserMessage): void {
    this.deliver(message, true);
  }

  /** No native steer surface on the bridge (V1 gap): degrade to a parked follow-up. */
  steer(message: UserMessage): void {
    this.remoteQueue.push({ message, sent: false });
  }

  inject(message: UserMessage): void {
    this.remoteQueue.push({ message, sent: false });
  }

  /** The bridge has no in-turn interrupt (V1 gap): record the cause; applied at the terminal. */
  cancel(cause: AgentCancelCause, _options?: CancelOptions): void {
    if (!this.turnOpen) return;
    if (this.cancelCause === null) this.cancelCause = cause;
  }

  async whenIdle(): Promise<void> {
    let activity: Promise<void>;
    do {
      activity = this.activityDone;
      await activity;
    } while (activity !== this.activityDone);
  }

  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return task(new AbortController().signal);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTurnDeadline();
    await this.client.close();
    await this.scope.dispose();
  }

  // ── internals ────────────────────────────────────────────────────────────

  private deliver(message: UserMessage, wakeup: boolean): void {
    if (this.disposed) return;
    if (this.turnOpen || this.streaming || !wakeup) {
      this.remoteQueue.push({ message, sent: false });
      return;
    }
    this.deliverPrompt(message);
  }

  private deliverPrompt(message: UserMessage): void {
    if (this.disposed) return;
    this.reserveTurn();
    this.beginActivity();
    void this.startTurn(message);
  }

  private sessionIdentityCommitted = false;

  /** Stamp the single-preset selection once per session (projection seed). */
  private bootstrapSessionIdentity(): void {
    if (this.sessionIdentityCommitted) return;
    this.sessionIdentityCommitted = true;
    if (!this.session.snapshotEvents().some((event) => event.type === "agent-preset/selected" && event.data?.agentPreset === "agy")) {
      this.session.append("agent-preset/selected", { agentPreset: "agy" });
    }
  }

  private async startTurn(message: UserMessage): Promise<void> {
    this.bootstrapSessionIdentity();
    this.session.append("turn/start", { turn: this.dashTurn });
    this.session.append("user/message", message, { surfaceOp: "append" });
    const text = userMessageText(message);

    // §17 onboarding (minimal): no key → answer locally, never spawn the bridge.
    if (this.runtimeInfo?.awaitingKey === true) {
      this.commitStepStart();
      if (looksLikeApiKey(text)) {
        this.runtimeInfo.onSaveApiKey(text.trim());
        this.appendSystemNotice("Gemini API key 已保存到本会话配置，现在开始。");
        trace("onboarding: key stored");
      } else {
        this.appendSystemNotice(ONBOARDING_PROMPT);
      }
      this.closeTurn({ kind: "completed" });
      this.markIdle();
      this.endActivity();
      return;
    }

    this.armTurnDeadline();
    this.pendingThinking = [];
    try {
      let full = "";
      for await (const chunk of this.client.turn(text)) {
        this.markRunning();
        this.ensureStreamBridge().push({ type: "text-delta", index: full.length, text: chunk });
        full += chunk;
      }
      this.clearTurnDeadline();
      // SDK 0.1.17 streams ToolCall but NEVER ToolResult (verified live and
      // in SDK source: receive_chunks yields Thought/Text/ToolCall only; the
      // result is fed to localharness via InputEvent and retained nowhere
      // public). Pair EVERY unpaired call with the truthful placeholder so
      // the log stays invariant-clean without fabricating outcomes — else
      // resume closers stamp them all "Interrupted".
      for (const call of this.unpairedCalls) {
        this.session.append("tool/result", {
          turn: this.dashTurn, step: this.step,
          message: createToolResultMessage({
            callId: ToolCallId(call.callId),
            content: [{ type: "text", text: "[the Antigravity SDK does not expose tool execution results]" }],
            isError: false,
          }),
        }, { surfaceOp: "append" });
      }
      this.unpairedCalls = [];
      const reasoning = this.pendingThinking.join("");
      this.pendingThinking = [];
      const usage = convertAgyUsage(this.client.lastUsage);
      if (this.step === 0) this.commitStepStart(); // no chunks streamed: open the step for the bare message
      this.appendAssistantMessage(full, { reasoning, usage });
      this.closeStep();
      this.closeTurn(this.cancelCause !== null ? { kind: "aborted", reason: this.cancelCause } : { kind: "completed" });
      this.cancelCause = null;
      trace(`turn ${this.dashTurn} done (${full.length} chars, conversation=${this.client.conversationId})`);
      this.runtimeInfo?.onTurnDone?.();
      this.markIdle();
      this.endActivity();
      this.flushFollowUps();
    } catch (error) {
      this.clearTurnDeadline();
      this.abandonStreamBridge();
      const failure = classifyTurnError(error);
      trace(`turn failed [${failure.code}]: ${failure.message.slice(0, 200)}`);
      for (const call of this.unpairedCalls) {
        this.session.append("tool/result", {
          turn: this.dashTurn, step: this.step,
          message: createToolResultMessage({
            callId: ToolCallId(call.callId),
            content: [{ type: "text", text: "[tool result unavailable: the turn failed]" }],
            isError: true,
          }),
        }, { surfaceOp: "append" });
      }
      this.unpairedCalls = [];
      if (this.turnOpen && this.step > 0) this.closeStep();
      this.closeTurn({ kind: "error", error: failure });
      this.markIdle();
      this.endActivity();
    }
  }

  private appendSystemNotice(text: string): void {
    if (!this.turnOpen) return;
    this.session.append(
      "system/message",
      { turn: this.dashTurn, step: this.step, message: createSystemMessage(text, "aw.agent-adapter-agy") },
      { surfaceOp: "append" },
    );
  }

  private appendAssistantMessage(text: string, extras?: { reasoning?: string; usage?: TokenUsage }): void {
    const content: ContentBlock[] = [];
    if (extras?.reasoning) content.push({ type: "reasoning", text: extras.reasoning });
    content.push({ type: "text", text });
    const assistant: AssistantMessage = createAssistantMessage({
      content,
      source: {
        provider: this.options.provider ?? "agy",
        model: this.options.model ?? "",
      },
    });
    const bridge = this.streamBridge;
    const event = this.session.append("assistant/message", {
      turn: this.dashTurn,
      step: this.step,
      message: assistant,
      stream: bridge?.records ?? [],
      // usage: the bridge emits it best-effort after the stream — when it is
      // missing there is NO usage field (never fabricated).
      ...(extras?.usage === undefined ? {} : { usage: extras.usage }),
    }, { surfaceOp: "append" });
    if (bridge !== undefined && !bridge.ended) bridge.settle(event.seq);
    this.streamBridge = undefined;
  }

  private ensureStreamBridge(): AssistantStreamBridge {
    if (this.streamBridge === undefined || this.streamBridge.ended) {
      this.streamBridge = new AssistantStreamBridge(
        this.session.id,
        ++this.assistantAttemptCounter,
        () => ++this.assistantStreamRevision,
        (frame) => this.dispatch.emit("agent/assistant-stream", { frame }),
      );
      this.commitStepStart();
      this.streamBridge.start(this.dashTurn, this.step);
    }
    return this.streamBridge;
  }

  private abandonStreamBridge(): void {
    if (this.streamBridge !== undefined && !this.streamBridge.ended) this.streamBridge.abandon();
    this.streamBridge = undefined;
  }

  private reserveTurn(): void {
    if (this.turnOpen) return;
    this.dashTurn = ++this.lastTurn;
    this.step = 0;
    this.turnOpen = true;
    this.markRunning();
  }

  private closeTurn(reason: TurnEndReason): void {
    if (!this.turnOpen) return;
    this.turnOpen = false;
    this.clearTurnDeadline();
    this.session.append("turn/end", { turn: this.dashTurn, reason });
  }

  private closeStep(): void {
    if (!this.turnOpen || this.step <= 0) return;
    this.session.append("step/end", { turn: this.dashTurn, step: this.step });
  }

  private commitStepStart(): void {
    if (!this.turnOpen) return;
    this.step += 1;
    this.session.append("step/start", { turn: this.dashTurn, step: this.step });
  }

  /** One-shot system stamp: the onboarding notice rides the first turn. */
  private markRunning(): void {
    if (this.streaming) return;
    this.streaming = true;
    this.dispatch.emit("agent/status", { status: "running" });
  }

  private markIdle(): void {
    if (!this.streaming) return;
    this.streaming = false;
    this.dispatch.emit("agent/status", { status: "idle" });
  }

  private beginActivity(): void {
    this.resolveActivityDone();
    this.activityDone = new Promise<void>((resolve) => {
      this.resolveActivityDone = resolve;
    });
  }

  private endActivity(): void {
    this.resolveActivityDone();
  }

  /** Flush ONE parked follow-up as a fresh prompt (never submit while busy). */
  private flushFollowUps(): void {
    if (this.disposed || this.turnOpen || this.streaming) return;
    const entry = this.remoteQueue.find((candidate) => !candidate.sent);
    if (entry === undefined) return;
    entry.sent = true;
    this.deliverPrompt(entry.message);
  }

  private pendingThinking: string[] = [];
  /** Calls from this turn still lacking a result (SDK 0.1.17 exposes none). */
  private unpairedCalls: Array<{ callId: string; name: string }> = [];

  private armTurnDeadline(): void {
    this.clearTurnDeadline();
    if (AGY_TURN_DEADLINE_MS <= 0) return;
    this.turnDeadlineTimer = setTimeout(() => {
      if (!this.turnOpen) return;
      trace(`turn deadline exceeded after ${AGY_TURN_DEADLINE_MS}ms — failing open turn`);
      this.abandonStreamBridge();
      if (this.step > 0) this.closeStep();
      this.closeTurn({ kind: "error", error: { message: `agy turn deadline exceeded after ${AGY_TURN_DEADLINE_MS}ms`, code: "UNKNOWN" } });
      this.markIdle();
      this.endActivity();
    }, AGY_TURN_DEADLINE_MS);
    this.turnDeadlineTimer.unref?.();
  }

  private clearTurnDeadline(): void {
    if (this.turnDeadlineTimer !== undefined) {
      clearTimeout(this.turnDeadlineTimer);
      this.turnDeadlineTimer = undefined;
    }
  }
}

/** Approval deadline for one bridge approval round-trip (fail closed). */
const AGY_APPROVAL_TIMEOUT_MS = 30_000;

/** Race a promise against its deadline (hermes raceApproval shape). */
function raceApproval(promise: Promise<unknown>, controller: AbortController, timeoutMs: number): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`approval timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/**
 * Map the bridge's best-effort usage event into Dash `TokenUsage`. The bridge
 * derives it from `conversation.last_turn_usage` AFTER the stream — when it is
 * absent there is NO usage field (never fabricated). `thinking_tokens` rides
 * along only when it is a subset of `output_tokens` (the DSH fold rejects a
 * larger value outright).
 */
export function convertAgyUsage(usage: { input_tokens: number; output_tokens: number; thinking_tokens: number; total_tokens: number } | undefined): TokenUsage | undefined {
  if (usage === undefined) return undefined;
  const inputTokens = Number(usage.input_tokens) || 0;
  const outputTokens = Number(usage.output_tokens) || 0;
  if (inputTokens === 0 && outputTokens === 0) return undefined;
  const result: TokenUsage = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
  const thinking = Number(usage.thinking_tokens) || 0;
  if (thinking > 0 && thinking <= outputTokens) result.reasoningTokens = thinking;
  return result;
}
