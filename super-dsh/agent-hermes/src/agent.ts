/**
 * HermesAgent — the Dash `Agent` shim over one `HermesGatewayClient` (the TUI
 * gateway JSON-RPC child, one bound gateway session per client).
 *
 * Bridges Hermes's wire event stream (the omp wire vocabulary projected by
 * hermes-events.ts) into the Dash `SessionEventMap`:
 *
 *   Hermes wire                      →  Dash session event
 *   ─────────────────────────────────────────────────────────────
 *   (prompt delivery)                →  turn/start + user/message
 *   agent_start                      →  status running + steer flush
 *   turn_start                       →  step/start
 *   message_update(text_delta)       →  (v2 stream frame, no log event)
 *   message_end(assistant)           →  assistant/message (+ usage, reasoning)
 *   message_end(toolResult)          →  tool/result (deduped vs tool_execution_end)
 *   tool_execution_start             →  tool/call
 *   tool_execution_end               →  tool/result
 *   turn_end                         →  step/end (+ status trace)
 *   agent_end                        →  turn/end + status idle
 *
 * One gateway turn (message.start → message.complete) is exactly one Dash turn,
 * so `turn/start`/`turn/end` boundaries are projected 1:1 around the wire
 * stream. The event `type` strings are IDENTICAL to the omp/codex bridges — the
 * same switch, with the gateway-line cuts applied:
 *
 * - NO user-message echo machinery: the gateway does not echo user messages, so
 *   the local append is authoritative and `message_start(role=user)` is never
 *   seen (the `#localUserPending` / `#bridgeRemoteUser` / `userMessageFromWire`
 *   machinery is gone).
 * - Native steer: `client.steer()` drives the in-flight gateway turn; a gateway
 *   idle-steer refusal (`{status:"rejected"}`) falls back to a plain `prompt()`.
 * - `followUp` submits a fresh prompt only once the gateway is idle (the
 *   gateway's default busy policy is interrupt — we never submit while busy).
 * - Runtime approval: `client.onApproval` → `ctx.get("approval").request()` →
 *   `approvalChoiceFromOutcome` → `"once" | "always" | "deny"` (fail closed).
 *
 * Token usage: Hermes attaches the raw usage to `message_end` (from
 * `message.complete`), so the assistant message carries it directly — no
 * one-turn lag. The conversion is fixture-grounded on the captured
 * `message.complete.usage` shape (`input` / `output` / `reasoning` / …; there
 * is no `cache_read` field to map, so no cache token is invented).
 *
 * Usage verdict (2026-09-17, fixture gateway-events.sample.json index 13):
 * the gateway's own `total` is CONTEXT-WIDE, not a per-message delta —
 * `total 26805 = prompt 26803 + completion 2` and `prompt === context_used`,
 * i.e. it scales with the whole re-sent context. convertUsage therefore
 * synthesizes the exact per-attempt total `input + output` (what the DSH
 * token-meter fold can prove for this attempt) instead of trusting `total`.
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
import { LlmAttemptId, ToolCallId, QUOTA_EXCEEDED_CODE, createAssistantMessage, createSystemMessage, createToolResultMessage } from "@deepseek-ai/dsh-llm";
import { createScope, type Scope } from "@deepseek-ai/dsh-scope";
import type { WireAssistantMessageEvent, WireContentBlock, WireEvent, WireMessage } from "./hermes-events.js";
import { GatewayRpcError, HERMES_SPAWN_ATTEMPTS, type HermesGatewayClient, type GatewayApprovalChoice, type GatewayApprovalRequest } from "./hermes-client.js";
import { approvalChoiceFromOutcome } from "./permission.js";
// compilation (the runtime service is mounted by the base bundle).
import type { CommandInvocation, CommandResult } from "@deepseek-ai/dsh-commands";

/**
 * v2 live assistant-stream publication for the Hermes bridge — the same frame
 * protocol the reference loop's AssistantStreamAttempt speaks (start marker,
 * dense zero-based chunks, terminal settlement) emitted over this agent's own
 * dispatch, so the session-controller folds Hermes's stream into its reconnect
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

/** Diagnostic trace (set HERMES_TRACE=1 on the dsh process to enable). */
const TRACE = process.env.HERMES_TRACE === "1";
const trace = (...parts: unknown[]): void => {
  if (TRACE) process.stderr.write(`[hermes-agent ${Date.now() % 1_000_000}] ${parts.join(" ")}\n`);
};

export function convertContent(blocks: WireContentBlock[] | undefined): ContentBlock[] {
  if (blocks === undefined) return [];
  // 0.1.6 renders blocks in ARRAY order; the native stream emits reasoning
  // BEFORE text, so gateway messages that trail their thinking blocks must be
  // hoisted — otherwise the WebUI draws "Thought for a while" AFTER the
  // response (2026-09-23 evidence).
  const reasoning: ContentBlock[] = [];
  const rest: ContentBlock[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        if (typeof block.text === "string") rest.push({ type: "text", text: block.text });
        break;
      case "thinking":
        if (typeof block.thinking === "string") reasoning.push({ type: "reasoning", text: block.thinking });
        break;
      case "toolCall": {
        const id = typeof block.id === "string" ? block.id : "";
        const name = typeof block.name === "string" ? block.name : "";
        const args = typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments ?? {});
        rest.push({ type: "tool-call", id: ToolCallId(id), name, arguments: args });
        break;
      }
      default:
        // images / unknown blocks are not bridged in V1.
        break;
    }
  }
  return [...reasoning, ...rest];
}

/**
 * Classify the wire's `stopReason: "error"` assistant message into a Dash
 * `failure` (`{ message, code }`). Same taxonomy as the harness adapters use
 * for `turn/end` reasons — `AUTH`, `RATE_LIMIT`, `QUOTA`, `SERVER` — so the
 * Web UI renders it through its own error path instead of an empty assistant
 * bubble.
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
 * Map Hermes's `message.complete.usage` accounting into Dash `TokenUsage`
/**
 * Map Hermes's `message.complete.usage` accounting into Dash `TokenUsage`
 * (fixture-grounded: the captured shape is `input` / `output` / `reasoning` /
 * `calls` / `total` / `context_used` / …). There is NO `cache_read` field in
 * the captured shape, so no cache token is invented (`cache_hit_pct` is a
 * percentage, not a token count).
 *
 * `totalTokens` is SYNTHESIZED as `input + output`, never the gateway's own
 * `total`: fixture math proves `total` is context-wide (26805 = prompt 26803
 * + completion 2, with `prompt === context_used` — the whole re-sent window),
 * while the DSH fold needs the per-attempt-provable sum. `reasoningTokens`
 * rides along only when `reasoning <= output` (Dash treats reasoning as a
 * subset of output; the fold rejects a larger value outright).
 */
export function convertUsage(usage: unknown): TokenUsage | undefined {
  if (usage === null || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const inputTokens = typeof u.input === "number" ? u.input : 0;
  const outputTokens = typeof u.output === "number" ? u.output : 0;
  if (inputTokens === 0 && outputTokens === 0) return undefined;
  const result: TokenUsage = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
  if (typeof u.reasoning === "number" && u.reasoning <= outputTokens) result.reasoningTokens = u.reasoning;
  return result;
}

/** Gateway RPC error codes that mean the stored gateway session no longer
 *  exists (session.resume against a pruned / unknown durable key). */
const NATIVE_SESSION_GONE_RPC_CODES = new Set([4001, 4006]);

/** What classifyTurnError needs besides the thrown value. */
export interface TurnErrorClassifyContext {
  /** Whether the gateway client can still serve RPCs (no terminal failure, not closed). */
  readonly clientUsable: boolean;
  /** The durable gateway session key this agent would resume, when known. */
  readonly storedSessionId: string | null;
}

/**
 * Classify a turn-failure into the stable `{message, code}` the Web UI error
 * chip renders (2026-09-17 ruling — never a bare UNKNOWN for a diagnosable
 * client/gateway state):
 *
 * - `GatewayRpcError` 4001/4006 → `NATIVE_SESSION_GONE` (the stored gateway
 *   session is gone; the message names it so the user can start fresh);
 * - gateway child exit/error → `GATEWAY_CRASH`;
 * - closed / terminal-failed client → `CLIENT_CLOSED`;
 * - anything else → `UNKNOWN` (genuinely unclassified).
 */
export function classifyTurnError(error: unknown, context: TurnErrorClassifyContext): { message: string; code: string } {
  if (error instanceof GatewayRpcError && error.code !== undefined && NATIVE_SESSION_GONE_RPC_CODES.has(error.code)) {
    return {
      message: `${error.message} (stored gateway session ${context.storedSessionId ?? "unknown"} is gone — start a new session)`,
      code: "NATIVE_SESSION_GONE",
    };
  }
  const text = error instanceof Error ? error.message : String(error);
  if (/^gateway child (?:exited|error)\b/.test(text)) return { message: text, code: "GATEWAY_CRASH" };
  if (!context.clientUsable) return { message: text, code: "CLIENT_CLOSED" };
  return { message: text, code: "UNKNOWN" };
}


/** Join the visible text blocks of a Dash user message into the Hermes prompt string. */
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
 * approval policy. Hermes has no runtime approval-policy switch either (the
 * preset is fixed; approval rides the gateway's runtime request/response), so
 * forwarding the text would steer it into an in-flight turn (interrupting tool
 * work) and echo it into history as a fake user prompt. Detect and drop it.
 */
function isApprovalNarration(message: UserMessage): boolean {
  const source = message.source;
  return source.kind === "plugin" && source.plugin === "user-approval";
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long an agent may sit idle before its gateway client is torn down. The
 * Dash host keeps resumed agents registered forever (nothing else disposes
 * them), and every idle agent pins a live gateway child. `0` disables the exit.
 */
const HERMES_IDLE_EXIT_MS = parseIdleExit(process.env.HERMES_IDLE_EXIT_MS);

function parseIdleExit(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 600_000;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : 600_000;
}

/**
 * Agent-level turn deadline: the client's `prompt()` resolves on the settled
 * pair (`message.complete` → `session.info running=false`), but a never-arriving
 * pair would hang the open Dash turn. This deadline fails the open turn
 * (`turn/end {kind:"error"}`) if no wire terminal arrived in time. `0` disables.
 */
const HERMES_TURN_DEADLINE_MS = parseTurnDeadline(process.env.HERMES_TURN_DEADLINE_MS);

function parseTurnDeadline(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 300_000;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : 300_000;
}

/** Approval deadline for one `approval.request` round-trip (fail closed). */
const HERMES_APPROVAL_TIMEOUT_MS = 30_000;

/**
 * Race an approval request against its deadline, aborting the controller on
 * timeout. Mirrors omp's `raceApproval` (AbortController + race + timeout),
 * not its select-card string matching.
 */
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

/** The tool identity of a gateway approval: `pattern_key` when present, else a generic name. */
function approvalToolName(req: GatewayApprovalRequest): string {
  const raw = req.raw as Record<string, unknown> | undefined;
  const key = typeof raw?.["pattern_key"] === "string" && raw["pattern_key"] !== "" ? raw["pattern_key"] : undefined;
  return key ?? "command";
}

/** The structural slice of `ctx.approval` the bridge calls. */
interface ApprovalServiceLike {
  request(req: {
    agent: HermesAgent;
    toolName: string;
    callId?: ToolCallId;
    reason?: string;
    signal?: AbortSignal;
  }): Promise<unknown>;
}

/**
 * Adapter-owned runtime facts the agent stamps into the session log / uses to
 * materialize the gateway session. Both facts are lazy on purpose: the Hermes
 * system prompt only becomes readable once the settled `session.info` carries a
 * non-empty `system_prompt` (after the first turn), and the catalog is an async
 * gateway RPC — each call fail-softs to `undefined`, and the agent retries or
 * skips.
 */
export interface HermesAgentRuntimeInfo {
  /** Hermes's own system prompt for this session, once the gateway reports one. */
  systemPrompt(): string | undefined;
  /** The gateway session's reported title (client-side session.info capture;
   * dedicated `session.title` events mirror as `session/title` via the agent). */
  sessionTitle(): string | undefined;
  /**
   * The effective hermes route for this session: the session's selected
   * {provider, model} pair wins, else the catalog default (real gateway
   * provider slug + verbatim model id, 2026-09-17 parity ruling). Resolves
   * through the memoized async catalog; returns `undefined` when neither is
   * known.
   */
  routeContext(selection: { provider?: string; model?: string } | undefined): Promise<{ provider: string; model: string; contextWindow?: number } | undefined>;
  /** The gateway-session materialization context for the lazy createSession/resumeSession. */
  /** The gateway-session materialization context for the lazy createSession/resumeSession. `resumeStoredSessionId` is the DURABLE state.db key. */
  readonly session: { cwd: string; resumeStoredSessionId: string | null; title?: string };
}

export class HermesAgent implements Agent {
  readonly id: SessionId;
  readonly options: AgentOptions;
  readonly session: Session;
  readonly inbox: Inbox;
  readonly ctx: Context;
  readonly #client: HermesGatewayClient;
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
  /** Last title mirrored into `session/title` (dedupes repeated gateway events). */
  #mirroredTitle: string | null = null;
  /** Live v2 assistant-stream publication for the in-flight wire message. */
  #streamBridge: AssistantStreamBridge | undefined;
  #assistantAttemptCounter = 0;
  #assistantStreamRevision = 0;

  /** A `turn_start` arrived; `step/start` is deferred until the step's owning turn is known. */
  #stepStartPending = false;
  /**
   * Deliveries forwarded through the client's own queue, in submission order.
   * `followUp` entries submit as a fresh prompt once the gateway is idle (never
   * while busy); `steer` entries drive the in-flight turn (or degrade to a
   * prompt on idle-steer refusal). `sent` marks entries already dispatched.
   */
  #remoteQueue: { message: UserMessage; sent: boolean; transport: "followUp" | "steer" }[] = [];
  #bridgedToolResults = new Set<string>();
  /** Fires when the agent has been idle past HERMES_IDLE_EXIT_MS (tears down the client). */
  readonly #onIdleExit: (() => void) | undefined;
  #idleExitTimer: NodeJS.Timeout | undefined = undefined;
  /** Fails the open turn if no wire terminal arrived within HERMES_TURN_DEADLINE_MS. */
  #turnDeadlineTimer: NodeJS.Timeout | undefined = undefined;
  #disposed = false;
  /** One-shot guard for the first-turn session-identity commit (#bootstrapSessionIdentity). */
  #sessionIdentityCommitted = false;
  /** Adapter-owned runtime facts (system prompt / route metadata / session context), when supplied. */
  readonly #runtimeInfo: HermesAgentRuntimeInfo | undefined;
  /** One-shot guard for the `system/message` surface node (never re-emitted). */
  #systemMessageDone = false;
  /** Last `request/context` route key (`provider/model`) — dedupes per-turn emits. */
  #lastRouteKey: string | null = null;
  /** Memoized route resolution (the async catalog is resolved once per agent). */
  #resolvedRoute: { provider: string; model: string; contextWindow?: number } | undefined;
  #routeResolved = false;

  constructor(loopCtx: Context, id: SessionId, options: AgentOptions, session: Session, client: HermesGatewayClient, onIdleExit?: () => void, runtimeInfo?: HermesAgentRuntimeInfo) {
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
    client.onApproval((req) => this.#handleApproval(req));
    // Session-identity events (the agent-preset stamp) are committed on the
    // FIRST turn by #bootstrapSessionIdentity — only once the client actually
    // exists — so a freshly created session announces completely blank,
    // exactly like the native agent-loop factory's.
    // `/permission` cannot switch here: Hermes approval is runtime
    // (gateway approval.request → Dash approval.request → respond); the preset
    // cannot be re-voiced. Shadowing the SAME name on this agent's own scope
    // fails cleanly instead of appending approval/policy events Hermes cannot
    // honor mid-session.
    this.ctx.inject(["commands"], (cmdCtx) =>
      cmdCtx.commands.register({
        name: "permission",
        description: "Unavailable for Hermes sessions (approval is handled at runtime through the gateway)",
        input: { hint: "<preset>" },
        handler: () => ({
          kind: "error" as const,
          text: "Approval is handled at runtime by the Hermes gateway (approval.request events); the permission preset cannot be switched for Hermes sessions.",
        }),
      }),
    );
    // `/compact` forwards to the gateway's native compaction surface
    // (session.compress). Unlike the codex V1 refusal, this runs real native
    // compaction inside the gateway session; DSH-side the compression is
    // reflected in subsequent session.info / usage.
    this.ctx.inject(["commands"], (cmdCtx) =>
      cmdCtx.commands.register({
        name: "compact",
        description: "Compact the Hermes gateway session (native session.compress)",
        input: { hint: "[instructions]" },
        handler: async () => {
          try {
            await this.#client.compress();
            return {
              kind: "success" as const,
              text: "Compaction requested: the Hermes gateway session is compacting (subsequent session.info/usage reflect the reduced context).",
            };
          } catch (error) {
            return { kind: "error" as const, text: `Compaction failed: ${String(error)}` };
          }
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
    // Idle → `prompt` (opens the Dash turn locally); busy → parked in the
    // remote queue and submitted as a fresh prompt once the gateway is idle.
    this.#deliver(message, "next-turn", true);
  }

  steer(message: UserMessage): void {
    // Mirrors dsh-agent-loop's `steer = send(input, "next-step", true)`: an
    // idle driver starts a turn; a running driver steers the in-flight gateway
    // turn (native `session.steer`, degrading to a prompt on idle refusal).
    this.#deliver(message, "next-step", true);
  }

  inject(message: UserMessage): void {
    // Dash-host approval-policy narrations have no Hermes runtime equivalent
    // (the preset is fixed; approval rides the gateway's runtime request
    // surface). Forwarding the text would steer it into an in-flight turn.
    if (isApprovalNarration(message)) {
      trace("inject: dropped approval-policy narration (Hermes has no runtime approval-policy switch)");
      return;
    }
    // Mirrors dsh-agent-loop's `inject = send(input, "next-step", false)`:
    // queued without waking; flushed at the next agent_start.
    this.#deliver(message, "next-step", false);
  }

  cancel(cause: AgentCancelCause, _options?: CancelOptions): void {
    // No active run → no-op. First cause wins: later cancels must not overwrite
    // an earlier cause (dash contract). The gateway interrupt cancels the
    // in-flight turn.
    if (!this.#streaming) return;
    if (this.#cancelCause === null) this.#cancelCause = cause;
    void this.#client.interrupt().catch(() => { });
  }

  async whenIdle(): Promise<void> {
    // Event-driven: wait for the current activity to settle (agent_end).
    // Hermes has no get_state polling surface — the wire terminal (agent_end),
    // which resolves #activityDone, is the authoritative idle signal.
    let activity: Promise<void>;
    do {
      activity = this.#activityDone;
      await activity;
    } while (activity !== this.#activityDone);
  }

  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    // Hermes has no maintenance concept; run the task directly.
    return task(new AbortController().signal);
  }

  /** Stop the gateway client and unwind the scoped world. Idempotent. */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    clearTimeout(this.#idleExitTimer);
    this.#idleExitTimer = undefined;
    this.#clearTurnDeadline();
    this.#client.close();
    await this.#scope.dispose();
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * Route one message by the reference loop's (target, wakeup) semantics:
   * an idle waking delivery starts a fresh local turn (`prompt`); a follow-up
   * sent while a turn is open is parked for a later idle submit; steering goes
   * through `steer` (consumed at the next step, or parked until agent_start).
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
    // Reserve the turn synchronously: busy-flag semantics stay identical to the
    // eager line, but NOTHING is appended yet — the log stays empty until the
    // gateway session exists, so a failed cold start leaves no orphan turn.
    this.#reserveTurn();
    clearTimeout(this.#idleExitTimer);
    this.#idleExitTimer = undefined;
    this.#beginActivity();
    void this.#startTurn(message);
  }

  /**
   * Cold-start path for one reserved turn: materialize the gateway session
   * (ensureStarted + createSession/resumeSession), commit the session-identity
   * events ahead of the turn (the agent-preset stamp), then append turn/start +
   * user/message and dispatch. A failed cold start synthesizes the failed turn
   * (turn/end with the error reason) so the UI's error path renders it, then
   * unwinds the reservation.
   */
  async #startTurn(message: UserMessage): Promise<void> {
    try {
      await this.#materializeSession();
      await this.#bootstrapSessionIdentity();
    } catch (error) {
      const failure = classifyTurnError(error, this.#failureContext());
      trace(`#startTurn cold start failed [${failure.code}]: ${failure.message}`);
      if (this.#turnOpen) {
        this.session.append("turn/start", { turn: this.#dashTurn });
        this.session.append("user/message", message, { surfaceOp: "append" });
        this.#closeTurn({ kind: "error", error: failure });
      }
      this.#endActivity();
      // A cold start against a dead client is the reported wedge (view-time
      // eager spawn + old reaper): dispose so the next prompt re-resumes fresh.
      this.#selfHealAfterClientTerminal();
      return;
    }
    if (this.#disposed) return;
    this.session.append("turn/start", { turn: this.#dashTurn });
    await this.#emitRequestContext();
    this.session.append("user/message", message, { surfaceOp: "append" });
    this.#armTurnDeadline();
    void this.#client
      .prompt(userMessageText(message))
      .then(() => this.#flushFollowUps())
      .catch((error) => this.#fail(error));
  }

  /**
   * Lazy gateway-session materialization (ruling 1): `ensureStarted()` then, on
   * the first prompt, `createSession` (fresh) or `resumeSession` (re-attach the
   * recorded gateway session id). The model rides the resolved route for a
   * fresh session (the gateway resolves the provider slug from the model id);
   * a resumed session restores its own model context.
   */
  async #materializeSession(): Promise<void> {
    // Spawn-side retry (client-internal, pre-ready, bounded at
    // HERMES_SPAWN_ATTEMPTS): the ready promise stays pending across python
    // respawns, so one await covers every attempt (2026-09-18 ruling).
    await this.#client.ensureStarted();
    if (this.#client.sessionId !== null) return;
    const route = await this.#resolveRoute();
    const sessionCtx = this.#runtimeInfo?.session;
    if (sessionCtx !== undefined && sessionCtx.resumeStoredSessionId !== null) {
      await this.#handshake(`session.resume`, () => this.#client.resumeSession(sessionCtx.resumeStoredSessionId as string));
      return;
    }
    await this.#handshake(`session.create`, () => this.#client.createSession({
      cwd: sessionCtx?.cwd ?? process.cwd(),
      ...(route?.model !== undefined ? { model: route.model } : {}),
      ...(sessionCtx?.title !== undefined && sessionCtx.title !== "" ? { title: sessionCtx.title } : {}),
    }));
  }

  /**
   * Handshake retry (2026-09-18 user ruling, ~3 attempts): transient failures
   * (RPC timeouts, transport hiccups) retry on the SAME client; GatewayRpcError
   * (the gateway ANSWERED — e.g. 4001/4006 session gone) and any terminal
   * client state fail immediately. Turn prompts are never auto-retried.
   */
  async #handshake(label: string, op: () => Promise<unknown>): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await op();
        return;
      } catch (error) {
        if (attempt >= HERMES_SPAWN_ATTEMPTS || error instanceof GatewayRpcError || !this.#client.usable) throw error;
        trace(`handshake ${label} attempt ${attempt}/${HERMES_SPAWN_ATTEMPTS} failed (${String(error).slice(0, 160)}) — retrying`);
      }
    }
  }

  /** Memoize the async route resolution (the catalog is a memoized promise). */
  async #resolveRoute(): Promise<{ provider: string; model: string; contextWindow?: number } | undefined> {
    if (this.#routeResolved) return this.#resolvedRoute;
    this.#routeResolved = true;
    this.#resolvedRoute = await this.#runtimeInfo?.routeContext({ provider: this.options.provider, model: this.options.model });
    return this.#resolvedRoute;
  }

  /**
   * Stamp the Hermes system prompt once per session as the step's surface node.
   * `system/message` is a step-scoped surface event, so this runs only after
   * `step/start` committed. Skips when the log already carries one (resume),
   * and while the gateway has not yet reported a non-empty `system_prompt` —
   * the call is retried on later steps until the text is available.
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
        message: createSystemMessage(text, "aw.agent-adapter-hermes"),
      },
      { surfaceOp: "append" },
    );
    this.#systemMessageDone = true;
    const title = this.#runtimeInfo.sessionTitle();
    if (title !== undefined && title !== "") trace(`session title: ${title}`);
    trace(`system/message stamped (${text.length} chars)`);
  }

  /**
   * Stamp route metadata for the next request (`request/context`): the
   * effective provider/model plus the catalog's context window when known.
   * Turn-enclosed (no step required) and deduped by route key.
   */
  async #emitRequestContext(): Promise<void> {
    if (this.#runtimeInfo === undefined || !this.#turnOpen) return;
    const route = await this.#resolveRoute();
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
   * The Hermes system prompt is stamped separately by #emitSystemMessage once
   * the gateway's `session.info` reports a non-empty `system_prompt`.
   */
  async #bootstrapSessionIdentity(): Promise<void> {
    if (this.#sessionIdentityCommitted) return;
    this.#sessionIdentityCommitted = true;
    if (!this.session.snapshotEvents().some((event) => event.type === "agent-preset/selected" && event.data?.agentPreset === "hermes")) {
      this.session.append("agent-preset/selected", { agentPreset: "hermes" });
    }
  }

  /**
   * Queue a message for client-side delivery. A `steer` entry dispatches now
   * when already streaming (native `session.steer`); a `followUp` entry parks
   * until the gateway is idle (never submit while busy).
   */
  #queueRemote(message: UserMessage, transport: "followUp" | "steer"): void {
    if (this.#disposed) return;
    clearTimeout(this.#idleExitTimer);
    this.#idleExitTimer = undefined;
    this.#remoteQueue.push({ message, sent: false, transport });
    if (this.#streaming && transport === "steer") this.#flushSteer();
  }

  /** Flush parked steer entries (native steer; a prompt fallback on idle refusal). */
  #flushSteer(): void {
    for (const entry of this.#remoteQueue) {
      if (entry.sent || entry.transport !== "steer") continue;
      entry.sent = true;
      const text = userMessageText(entry.message);
      trace(`-> steer "${text.slice(0, 40)}"`);
      // Ruling 2: steer while streaming → client.steer; a gateway idle-steer
      // refusal ({status:"rejected"}) falls back to a plain prompt.
      void this.#client.steer(text).catch(() => this.#client.prompt(text).catch((error) => this.#fail(error)));
    }
  }

  /** Flush ONE parked follow-up as a fresh prompt (the gateway is now idle). */
  #flushFollowUps(): void {
    const entry = this.#remoteQueue.find((candidate) => !candidate.sent && candidate.transport === "followUp");
    if (entry === undefined) return;
    entry.sent = true;
    this.#deliverPrompt(entry.message);
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
  }

  #closeTurn(reason: TurnEndReason): void {
    if (!this.#turnOpen) return;
    this.#turnOpen = false;
    this.#clearTurnDeadline();
    this.session.append("turn/end", { turn: this.#dashTurn, reason });
  }

  /**
   * Append the deferred `step/start` now that the step's first message has
   * revealed which Dash turn owns it. On-demand open: the gateway may emit
   * `tool.complete` without a preceding `message.start`, so a step opens at the
   * first step-scoped use rather than only on a `message_start`.
   */
  #commitStepStart(): void {
    if (!this.#turnOpen) return;
    if (!this.#stepStartPending && this.#step > 0) return;
    this.#stepStartPending = false;
    this.#step += 1;
    this.session.append("step/start", { turn: this.#dashTurn, step: this.#step });
    trace(`step/start turn=${this.#dashTurn} step=${this.#step}`);
  }

  #beginActivity(): void {
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

  #armIdleExit(): void {
    if (this.#disposed || this.#onIdleExit === undefined || HERMES_IDLE_EXIT_MS === 0) return;
    if (this.#remoteQueue.some((entry) => !entry.sent)) return;
    clearTimeout(this.#idleExitTimer);
    this.#idleExitTimer = setTimeout(() => {
      this.#idleExitTimer = undefined;
      void this.#revalidateIdleExit();
    }, HERMES_IDLE_EXIT_MS);
    this.#idleExitTimer.unref?.();
  }

  /**
   * Quiescence re-validation at fire time. Hermes has no get_state/get_subagents
   * surface, so local signals (#streaming + the remote queue) are authoritative.
   */
  async #revalidateIdleExit(): Promise<void> {
    if (this.#disposed || this.#streaming) return this.#armIdleExit();
    if (this.#remoteQueue.some((entry) => !entry.sent)) return this.#armIdleExit();
    trace(`idle exit after ${HERMES_IDLE_EXIT_MS}ms — disposing agent ${this.id}`);
    this.#onIdleExit?.();
  }

  #armTurnDeadline(): void {
    this.#clearTurnDeadline();
    if (HERMES_TURN_DEADLINE_MS <= 0) return;
    this.#turnDeadlineTimer = setTimeout(() => {
      if (!this.#turnOpen) return;
      trace(`turn deadline exceeded after ${HERMES_TURN_DEADLINE_MS}ms — failing open turn`);
      this.#closeTurn({ kind: "error", error: { message: `hermes turn deadline exceeded after ${HERMES_TURN_DEADLINE_MS}ms (no wire terminal arrived)`, code: "UNKNOWN" } });
      // Stop the gateway turn too — otherwise the busy guard would refuse every
      // later prompt and a late terminal could append step-scoped events after
      // the closed turn (I1 fix r1).
      void this.#client.interrupt().catch(() => { });
      this.#endActivity();
    }, HERMES_TURN_DEADLINE_MS);
    this.#turnDeadlineTimer.unref?.();
  }

  #clearTurnDeadline(): void {
    if (this.#turnDeadlineTimer !== undefined) {
      clearTimeout(this.#turnDeadlineTimer);
      this.#turnDeadlineTimer = undefined;
    }
  }

  /** The classification context for turn failures: client liveness plus the
   *  durable gateway session key (for NATIVE_SESSION_GONE messages). */
  #failureContext(): TurnErrorClassifyContext {
    return {
      clientUsable: this.#client.usable,
      storedSessionId: this.#runtimeInfo?.session.resumeStoredSessionId ?? this.#client.storedSessionId,
    };
  }

  /**
   * Self-heal (2026-09-17 ruling 4): a CLIENT-TERMINAL failure leaves this
   * agent registered with a dead client — every later prompt would fail
   * forever with a closed transport. Trigger the full idle-exit dispose (the
   * host unregisters the agent and re-resumes a FRESH client on the next
   * prompt). Ordinary per-turn failures (usable client) never dispose.
   */
  #selfHealAfterClientTerminal(): void {
    if (this.#disposed || this.#client.usable) return;
    trace(`client terminal — idle-exit dispose for self-heal (agent ${this.id})`);
    this.#onIdleExit?.();
  }

  #fail(error: unknown): void {
    this.#abandonStreamBridge();
    if (this.#disposed) return;
    const failure = classifyTurnError(error, this.#failureContext());
    trace(`#fail [${failure.code}] ${failure.message.slice(0, 200)}`);
    this.#closeTurn({ kind: "error", error: failure });
    this.#markIdle();
    this.#endActivity();
    this.#selfHealAfterClientTerminal();
  }


  /**
   * Bridge one gateway approval (`approval.request`) through the Dash approval
   * seam (`ctx.get("approval").request()`), mapping the outcome to the gateway
   * choice. No approval service / throw / timeout → "deny" (fail closed).
   */
  async #handleApproval(req: GatewayApprovalRequest): Promise<GatewayApprovalChoice> {
    const approval = this.ctx.get("approval") as ApprovalServiceLike | undefined;
    if (approval === undefined) {
      trace("approval: no approval service — deny (fail closed)");
      return "deny";
    }
    const raw = req.raw as Record<string, unknown> | undefined;
    const choices = Array.isArray(raw?.["choices"]) ? (raw["choices"] as string[]) : undefined;
    const toolName = approvalToolName(req);
    const reason = req.title !== "" ? req.title : undefined;
    const controller = new AbortController();
    try {
      const outcome = await raceApproval(
        approval.request({
          agent: this,
          toolName,
          ...(reason === undefined ? {} : { reason }),
          signal: controller.signal,
        }),
        controller,
        HERMES_APPROVAL_TIMEOUT_MS,
      );
      const choice = approvalChoiceFromOutcome(outcome, choices);
      trace(`approval: ${toolName} → ${choice}`);
      return choice;
    } catch {
      trace(`approval: ${toolName} request failed — deny (fail closed)`);
      return "deny";
    }
  }

  #handleEvent(event: WireEvent): void {
    switch (event.type) {
      case "agent_start":
        trace("event agent_start");
        this.#markRunning();
        this.#flushSteer();
        break;
      case "turn_start":
        trace("event turn_start");
        this.#stepStartPending = true;
        this.#pendingFailure = null;
        this.#commitStepStart();
        this.#emitSystemMessage();
        break;

      case "message_start": {
        const message = event.message as WireMessage | undefined;
        if (message?.role === "assistant") {
          // Reset per-message streaming accumulators.
          this.#abandonStreamBridge();
        }
        // role === "toolResult" is bridged in message_end (deduped vs tool_execution_end).
        this.#commitStepStart();
        this.#emitSystemMessage();
        break;
      }

      case "message_update": {
        const delta = event.assistantMessageEvent as WireAssistantMessageEvent | undefined;
        if (delta !== undefined) this.#handleUpdate(delta);
        break;
      }

      case "message_end": {
        // Late terminal after the turn closed (deadline/interrupt): never append
        // step-scoped surface events past turn/end.
        if (!this.#turnOpen) break;
        const message = event.message as WireMessage | undefined;
        if (message === undefined) break;
        const role = message.role as string;
        if (role === "assistant") {
          const failure = wireFailure(message);
          if (failure !== undefined) {
            this.#pendingFailure = failure;
            this.#abandonStreamBridge();
          } else {
            // Hermes attaches the raw usage to message_end (message.complete);
            // the assistant message carries it directly — no one-turn lag.
            this.#appendAssistantMessage(message, convertUsage(event.usage));
          }
        } else if (role === "toolResult") {
          this.#appendToolResultMessage(message);
        } else if (role !== "user") {
          process.stderr.write(`hermes wire: unhandled message_end role "${role}"\n`);
        }
        break;
      }

      case "tool_execution_start": {
        if (!this.#turnOpen) break;
        const callId = String(event.toolCallId ?? "");
        const name = String(event.toolName ?? "");
        this.#commitStepStart();
        this.session.append("tool/call", {
          turn: this.#dashTurn,
          step: this.#step,
          callId: ToolCallId(callId),
          name,
          arguments: String(event.argumentsJson ?? JSON.stringify(event.args ?? {})),
        });
        break;
      }

      case "tool_execution_end":
        if (!this.#turnOpen) break;
        this.#appendToolResult(event);
        break;

      case "turn_end":
        trace("event turn_end");
        this.#emitSystemMessage();
        if (this.#turnOpen && this.#step > 0) {
          this.session.append("step/end", { turn: this.#dashTurn, step: this.#step });
        }
        // Usage rides message_end (converted there); turn_end's `data.status` is trace-only.
        {
          const status = (event.data as { status?: unknown } | undefined)?.status;
          if (typeof status === "string" && status !== "") trace(`turn status: ${status}`);
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
        this.#mirrorTitle(typeof event.name === "string" ? event.name : undefined);
        break;

      case "todo_updated":
        this.#writeTodos(event.todos);
        break;
    }
  }

  /**
   * Mirror the gateway's session title into a `session/title` event (pi
   * pattern). Dash does not generate titles for Hermes sessions; the gateway
   * owns the title (`session.title` events). Empty or unchanged titles are
   * ignored, and a title is never allowed to affect the turn.
   */
  #mirrorTitle(name: string | undefined): void {
    if (name === undefined || name.trim() === "" || name === this.#mirroredTitle) return;
    this.#mirroredTitle = name;
    try {
      (this.session.append as (type: string, data: unknown) => unknown)("session/title", {
        title: name,
        messageSeqs: [],
        source: { kind: "provider", provider: "hermes" },
      });
      trace(`session/title ← hermes: "${name}"`);
    } catch {
      // fail-soft: a title never affects the turn
    }
  }

  /**
   * Log-only `todo/write` whole-list snapshot (upstream tool-todo contract;
   * latest write wins on replay). The projector already mapped the gateway's
   * todo snapshot onto DSH todo items; only append inside an open turn (the
   * upstream invariant refuses todo/write outside any open turn), and never
   * let panel state break the turn.
   */
  #writeTodos(todos: unknown): void {
    if (!Array.isArray(todos) || !this.#turnOpen) return;
    try {
      (this.session.append as (type: string, data: unknown) => unknown)("todo/write", { todos });
      trace(`todo/write ${todos.length} item(s)`);
    } catch {
      // fail-soft: the todo panel is presentation state
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

  #appendAssistantMessage(message: WireMessage, usage?: TokenUsage): void {
    const content = convertContent(message.content);
    const assistant: AssistantMessage = createAssistantMessage({
      content,
      source: {
        provider: String(message.provider ?? this.options.provider ?? ""),
        model: String(message.model ?? this.options.model ?? ""),
      },
    });
    const bridge = this.#streamBridge;
    this.#commitStepStart();
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
