/**
 * ClaudeAgent — the Dash `Agent` shim over one `ClaudeSdkClient` (a
 * per-session Claude Agent SDK bridge).
 *
 * Bridges Claude's wire event stream (the neutral vocabulary projected by
 * claude-events.ts) into the Dash `SessionEventMap`:
 *
 *   Claude wire                      →  Dash session event
 *   ────────────────────────────────────────────────────────────────
 *   (prompt delivers)                →  turn/start + request/context + user/message
 *   (first step-scoped event)        →  step/start + system/message (once per session)
 *   assistant_reasoning              →  live stream chunk + assistant/message {reasoning}
 *   assistant_text                   →  live stream chunk + assistant/message {text}
 *   tool_start                       →  tool/call (+ todo/write for TodoWrite)
 *   tool_end                         →  tool/result
 *   compact_boundary                 →  compaction/start + compaction/end bracket
 *   result (turn_end)                →  turn/end (+ usage)
 *   permission_denied                →  log-only trace
 *   model_refusal_fallback           →  retracted uuids traced + content re-projected
 *
 * One Claude turn (user prompt → result) maps to one Dash turn. A Dash step
 * is one model attempt: the SDK delivers COMPLETE assistant messages (no
 * deltas), each of which streams one live bridge chunk and buffers its text;
 * the buffer flushes to an `assistant/message` immediately BEFORE the first
 * `tool/call` it requested and again at `turn_end`. When a new assistant
 * message arrives after the current step's attempt was already flushed, the
 * step closes and the next one opens — the turn-usage fold requires exactly
 * one assistant/message (one usage sample) per step.
 *
 * Usage: Claude reports accounting on every assistant message AND at
 * `result` (`turn_end`). Every flush attaches the sample of the message that
 * opened the attempt (RC-6) — the mid-turn `tool_start` flush included — so
 * every tool turn proves its usage; `totalTokens` is synthesized from
 * Claude's own counters. Nothing stashes across turns.
 *
 * The module is deliberately plain-TS-`private` (never `#`): the agent is
 * handed to `ctx.agents.enter`, whose scope carrier and Cordis tracing proxy
 * break on hard-private receivers.
 */
import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type {
  Agent,
  AgentOptions,
  AgentStatus,
  AssistantStreamFrame,
  CancelOptions,
  InboxTarget,
} from "@deepseek-ai/dsh-agent";
import { agentEvents, type AgentEventDispatch } from "@deepseek-ai/dsh-agent";
import type {
  AgentCancelCause,
  Session,
  SessionId,
  SessionSeq,
  TurnEndReason,
  UserMessage,
} from "@deepseek-ai/dsh-session";
import type { AssistantMessage, AssistantStreamRecord, ContentBlock, StreamChunk, TokenUsage } from "@deepseek-ai/dsh-llm";
import {
  LlmAttemptId,
  ToolCallId,
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
} from "@deepseek-ai/dsh-llm";
// Type-only: pulls dsh-commands' `Context.commands` augmentation into this unit.
// The mirror itself talks to the registry through src/commands.ts' structural type.
import type { CommandRuntime } from "@deepseek-ai/dsh-commands";
import { createScope, type Scope } from "@deepseek-ai/dsh-scope";
import { toClaudeContent, type DshContentBlock, type ResolvedAttachment } from "./content.js";
import { Inbox } from "./inbox.js";
import type { ClaudeInputContent } from "./input-queue.js";
import type { WireEvent } from "./claude-events.js";
import { resetProjectionState } from "./claude-events.js";
import type { ClaudeSdkClient } from "./claude-client.js";
import { CLAUDE_PROVIDER_ID } from "./adapter.js";
import { claudePermissionMode, presetFromEvents, type ClaudePermissionMode, type PresetName } from "./permission.js";
import { catalogFromInit, modelEntryFromSdk, readModelCatalog, setModelCatalog } from "./models.js";
import {
  registerClaudeCommands,
  slashCommandsFromReported,
  type CommandRuntimeLike,
  type SlashCommandLike,
} from "./commands.js";

/** The agent-preset selection event (mirrors dsh-agent-presets' declaration, which this adapter does not import). */
/**
 * Log-only session event keys this adapter appends that the locally-resolved
 * dsh-session build does not know (upstream declares `todo/write` in
 * packages/todo/tool-todo and `compaction/*` in packages/compaction, whose
 * types this project does not reference; `approval/policy` comes from
 * dsh-user-approval's own augmentation and is reached through the trailing
 * cast). Mirrors the local-declaration pattern of permission.ts.
 */
declare module "@deepseek-ai/dsh-session/types" {
  interface SessionEventMap {
    "agent-preset/selected": { agentPreset: string };
    "todo/write": { todos: { content: string; status: "pending" | "in_progress" | "completed" }[] };
    "approval/policy": { policy: string };
    "compaction/start": { compactionId: string; turn: number | null };
    "compaction/end": { compactionId: string; turn: number | null; error?: string };
  }
}
/** Diagnostic trace (set CLAUDE_TRACE=1 on the dsh process to enable). */
const TRACE = process.env.CLAUDE_TRACE === "1";
const trace = (...parts: unknown[]): void => {
  if (TRACE) process.stderr.write(`[claude-agent ${Date.now() % 1_000_000}] ${parts.join(" ")}\n`);
};

/**
 * Adapter-owned runtime facts the provider resolves ONCE at create/resume and
 * hands to the agent, so the `permission/preset` stamp, the live
 * `setPermissionMode` call and the persisted record all derive from one
 * `claudePermissionMode(preset)` result (never computed twice).
 */
export interface ClaudeAgentRuntimeInfo {
  /** The DSH permission preset for this session, when one is known. */
  readonly preset: PresetName | undefined;
  /** The effective Claude permission mode (single source). */
  readonly claudeMode: ClaudePermissionMode;
  /** Persist a runtime mode change into the session record (resume re-mount). */
  readonly onModeChange?: (mode: ClaudePermissionMode) => void;
  /** Mark the pairing dead in the session map (conversation never materialized). */
  readonly onNotResumable?: () => void;
}

/**
 * Classify a Claude-side failure into a stable turn-error code (2026-09-18).
 * `CONVERSATION_NOT_FOUND` is terminal for the pairing: the CLI never
 * materialized a conversation under the recorded derived id (e.g. a failed
 * first turn), so every later prompt would fail identically — the session is
 * marked not resumable and ignored (user ruling: never resurrect, never
 * re-wrap prior content).
 */
export function classifyClaudeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return /No conversation found with session ID/i.test(text) ? "CONVERSATION_NOT_FOUND" : "UNKNOWN";
}

/** Map Claude's `result.usage` accounting into Dash `TokenUsage`. */
/** Map Claude's `result.usage` / assistant-message accounting into Dash `TokenUsage`. */
export function convertUsage(usage: unknown): TokenUsage | undefined {
  if (usage === null || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const inputTokens = typeof u.input_tokens === "number" ? u.input_tokens : 0;
  const outputTokens = typeof u.output_tokens === "number" ? u.output_tokens : 0;
  if (inputTokens === 0 && outputTokens === 0) return undefined;
  const cacheReadTokens = typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : 0;
  const cacheWriteTokens = typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : 0;
  // Synthesize the exact total from Claude's own counters (RC-6): the
  // turn-usage fold's `normalizeUsage` needs `totalTokens` (or BOTH cache
  // buckets) to prove an attempt, and prompt = input + cacheRead + cacheWrite
  // is exactly the identity Claude's accounting guarantees.
  const result: TokenUsage = {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens,
  };
  if (cacheReadTokens > 0) result.cacheReadTokens = cacheReadTokens;
  if (cacheWriteTokens > 0) result.cacheWriteTokens = cacheWriteTokens;
  return result;
}

/** Text-only preview of a Dash user message for the delivery trace. */
function userMessagePreview(message: UserMessage): string {
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text") parts.push(block.text);
  }
  return parts.join("\n");
}

/**
 * The slice of the DSH attachment service this prompt path consumes
 * (`ctx.attachments`). `readImage` returns the verified bytes plus the
 * normalized reference whose `mediaType` is authoritative.
 */
interface ClaudeAttachmentsLike {
  readImage(
    ref: unknown,
    signal?: AbortSignal,
  ): Promise<{ ref?: { mediaType?: unknown } | undefined; data?: unknown } | undefined>;
}

/** The verified image reference returned by `readImage`, defensively read. */
function storedMediaType(stored: { ref?: { mediaType?: unknown } | undefined } | undefined): string | undefined {
  const mediaType = stored?.ref?.mediaType;
  return typeof mediaType === "string" && mediaType !== "" ? mediaType : undefined;
}

/** A non-empty string field, or undefined when absent/blank/unusable. */
function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Human-readable detail for a contained failure. */
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message === "" ? "unknown error" : message;
}

/**
 * One transcoded prompt: either the content to push, or a refusal when nothing
 * attachable survived. An empty result must NOT be pushed as `""` — that is
 * exactly the empty-text block the transcoder refuses to emit (the Anthropic
 * API rejects it) — so the caller fails the turn loudly instead.
 */
type PromptPayload =
  | { readonly kind: "content"; readonly content: ClaudeInputContent }
  | { readonly kind: "empty"; readonly reason: string };

/** One durable attachment reference projected into the fields the transcoder reads. */
function attachmentFields(ref: unknown): { mediaType?: string; attachmentId?: string } {
  if (ref === null || typeof ref !== "object") return {};
  const record = ref as Record<string, unknown>;
  return {
    ...(typeof record.mediaType === "string" ? { mediaType: record.mediaType } : {}),
    ...(typeof record.attachmentId === "string" ? { attachmentId: record.attachmentId } : {}),
  };
}

/**
 * Project one Dash user message's content blocks into the transcoder's input.
 * Text, image and file blocks are ALL forwarded: an unattachable one must reach
 * the transcoder so it is reported, not passed over. Reasoning and tool blocks
 * are not user-attachable content and carry no wire meaning here.
 */
function dshPromptBlocks(content: readonly ContentBlock[]): DshContentBlock[] {
  const blocks: DshContentBlock[] = [];
  for (const block of content) {
    switch (block.type) {
      case "text":
        blocks.push({ type: "text", text: block.text });
        break;
      case "image":
      case "file":
        blocks.push({ type: block.type, ...attachmentFields(block.attachment) });
        break;
      default:
        break;
    }
  }
  return blocks;
}

/**
 * How long an agent may sit idle before its Claude client is torn down. The
 * Dash host keeps resumed agents registered forever, and every idle agent pins
 * a live CLI subprocess. `0` disables the exit.
 */
const CLAUDE_IDLE_EXIT_MS = parseIdleExit(process.env.CLAUDE_IDLE_EXIT_MS);

function parseIdleExit(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 600_000;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : 600_000;
}

/** Text/reasoning blocks for a refusal-fallback `content` payload. */
function refusalBlocks(content: unknown): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  const blocks: ContentBlock[] = [];
  for (const raw of content) {
    if (raw === null || typeof raw !== "object") continue;
    const block = raw as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string" && block.text !== "") {
      blocks.push({ type: "text", text: block.text });
    } else if (block.type === "reasoning" && typeof block.text === "string" && block.text !== "") {
      blocks.push({ type: "reasoning", text: block.text });
    }
  }
  return blocks;
}


/**
 * v2 live assistant-stream publication for the Claude bridge — the same
 * frame protocol the reference loop's AssistantStreamAttempt speaks (start
 * marker, dense zero-based chunks, terminal settlement) emitted over this
 * agent's own dispatch, so the session-controller folds the stream into its
 * reconnect baseline. The SDK delivers COMPLETE assistant messages (no
 * deltas), so each arriving message's text/thinking pushes ONE chunk — that
 * alone makes the text visible before the first `tool_start` flush. Chunks
 * also accumulate as raw durable records embedded in the final
 * assistant/message.
 */
class AssistantStreamBridge {
  readonly attemptId: LlmAttemptId;
  readonly records: AssistantStreamRecord[] = [];
  private nextRevision: () => number;
  private emitFrame: (frame: AssistantStreamFrame) => void;
  private index = 0;
  private terminal = false;

  constructor(sessionId: SessionId, attempt: number, nextRevision: () => number, emitFrame: (frame: AssistantStreamFrame) => void) {
    this.attemptId = LlmAttemptId(`${sessionId}:${attempt}`);
    this.nextRevision = nextRevision;
    this.emitFrame = emitFrame;
  }

  /** Whether the terminal frame already fired. */
  get ended(): boolean {
    return this.terminal;
  }

  /** Opening marker before the first delivered chunk. */
  start(turn: number, step: number): void {
    this.emitFrame({ type: "start", attemptId: this.attemptId, revision: this.nextRevision(), turn, step });
  }

  /** One live chunk: durable record plus dense process-local frame. */
  push(chunk: StreamChunk): void {
    const time = Date.now();
    this.records.push({ type: "chunk", time, chunk });
    this.emitFrame({ type: "chunk", attemptId: this.attemptId, revision: this.nextRevision(), index: this.index++, time, chunk });
  }

  /** Terminal settlement after the durable assistant/message committed. */
  settle(seq: SessionSeq): void {
    this.terminal = true;
    this.emitFrame({ type: "end", attemptId: this.attemptId, revision: this.nextRevision(), index: this.index, outcome: { kind: "committed", eventType: "assistant/message", seq } });
  }

  /** No durable attempt event will commit. */
  abandon(): void {
    this.terminal = true;
    this.emitFrame({ type: "end", attemptId: this.attemptId, revision: this.nextRevision(), index: this.index, outcome: { kind: "abandoned" } });
  }
}

export class ClaudeAgent implements Agent {
  readonly id: SessionId;
  readonly options: AgentOptions;
  readonly session: Session;
  readonly inbox: Inbox;
  readonly ctx: Context;
  private readonly client: ClaudeSdkClient;
  private readonly loopCtx: Context;
  private readonly scope: Scope;
  private readonly dispatch: AgentEventDispatch;

  private streaming = false;
  private activityDone: Promise<void> = Promise.resolve();
  private resolveActivityDone: () => void = () => { };
  private dashTurn = 0;
  private step = 0;
  private lastTurn = 0;
  private turnOpen = false;
  private cancelCause: AgentCancelCause | null = null;

  /** Accumulated reasoning text of the in-flight assistant message. */
  private reasoningBuffer = "";
  /** Accumulated visible text of the in-flight assistant message. */
  private textBuffer = "";
/** Usage captured from the latest projected assistant message (RC-6). */
  private capturedUsage: TokenUsage | undefined = undefined;
  /** The model the CLI put on the latest assistant message (observed, not requested). */
  private observedMessageModel = "";
  /** Whether the current step already committed its `assistant/message` (one attempt per step). */
  private stepFlushed = false;
  /** Whether a step is currently OPEN (the counter itself never resets mid-turn). */
  private stepOpen = false;
  /** One-shot guard for the `system/message` surface node (never re-emitted). */
  private systemMessageDone = false;
  /** Last `request/context` route key (`provider/model`) — dedupes per-turn emits. */
  private lastRouteKey: string | null = null;
  /** Live v2 assistant-stream publication for the in-flight wire message. */
  private streamBridge: AssistantStreamBridge | undefined;
  private assistantAttemptCounter = 0;
  private assistantStreamRevision = 0;
  /** In-flight nested (subagent) tool calls, tracked from `parent_tool_use_id`. */
  private subagentCount = 0;
  /** In-flight approval requests (the interaction bridge is wired in a later task). */
  /** In-flight approval requests, tracked around the interaction bridge. */
  private pendingApproval = 0;
  /** The runtime's own default model (from `session_init`), for the catalog. */
  private observedDefaultModel = "";

  /** Deliveries parked while idle without a wakeup; flushed at the next prompt. */
  private remoteQueue: { message: UserMessage; sent: boolean; transport: "followUp" | "steer" }[] = [];
  /** Serialization chain for async prompt deliveries (attachment prefetch). */
  private deliveryChain: Promise<void> = Promise.resolve();
  private sessionIdentityCommitted = false;
  private disposed = false;
  private idleExitTimer: NodeJS.Timeout | undefined = undefined;
  private readonly onIdleExit: (() => void) | undefined;
  private readonly runtimeInfo: ClaudeAgentRuntimeInfo | undefined;
  private notResumableMarked = false;

  /**
   * Claude's advertised command surface for THIS session, as last observed
   * (`session_init.slash_commands`, then enriched by `supportedCommands()`).
   * Read live by the registration mirror's `listSlashCommands`.
   */
  private observedSlashCommands: readonly SlashCommandLike[] = [];
  /** The agent-scoped `commands` service, once the registry is available. */
  private commandsAccessor: { commands: CommandRuntimeLike } | undefined = undefined;
  /** Signature of the mirrored list, so an unchanged re-observation is a no-op. */
  private commandsSignature = "";
  /** Releases the current mirror before it is rebuilt or the agent is disposed. */
  private commandsDisposer: (() => void) | undefined = undefined;

  constructor(
    loopCtx: Context,
    id: SessionId,
    options: AgentOptions,
    session: Session,
    client: ClaudeSdkClient,
    onIdleExit?: () => void,
    runtimeInfo?: ClaudeAgentRuntimeInfo,
  ) {
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
    // Claude's slash commands are session state, so the mirror is registered on
    // THIS agent's scope (`this.ctx` carries the agent's scope key): the
    // registry then resolves it as an agent-scoped shadow, which is what keeps
    // sibling sessions from colliding on the same `claude-*` names and what
    // disposes the mirror with the session. `inject` also re-runs if the
    // commands service is reloaded, so the mirror is rebuilt against the new
    // registry instance.
    this.ctx.inject(["commands"], (commandCtx) => {
      this.attachCommandRuntime(commandCtx.commands);
    });
    this.lastTurn = session.snapshotEvents().findLast((event) => event.type === "turn/start")?.data.turn ?? 0;
    client.on((event) => this.handleEvent(event));
    // Session-start projection reset: the module-level tool-name map must never
    // leak another session's tool into this one (Task 4 review finding).
    resetProjectionState();
    // Mid-session permission switching: reconcile the effective Claude mode on
    // every DSH permission event (RC-5). `permission/preset` carries the mode
    // itself; `sandbox/mode` names the skeleton preset directly; an
    // `approval/policy` alone cannot pick a mode, so the log is re-folded.
    this.ctx.on("session/event", (session, event) => {
      if (session !== this.session) return;
      if (event.type !== "permission/preset" && event.type !== "sandbox/mode" && event.type !== "approval/policy") return;
      let mode: ClaudePermissionMode | undefined;
      if (event.type === "permission/preset") {
        mode = event.data.claudeMode ?? claudePermissionMode(event.data.preset);
      } else if (event.type === "sandbox/mode") {
        // The skeleton's sandbox mode names ARE the preset names.
        mode = claudePermissionMode(event.data.mode);
      }
      if (mode === undefined) {
        const folded = presetFromEvents(this.session.snapshotEvents());
        if (folded === undefined) return;
        mode = claudePermissionMode(folded);
      }
      trace(`${event.type} observed — re-applying claudeMode ${mode}`);
      void this.client.setPermissionMode(mode).catch((error) => {
        trace(`setPermissionMode ${mode} failed: ${String(error)}`);
      });
      this.runtimeInfo?.onModeChange?.(mode);
    });
  }

  get status(): AgentStatus {
    return this.streaming ? "running" : "idle";
  }

  /** Drive one prompt (the primary driving surface). */
  prompt(message: UserMessage): void {
    this.deliver(message, "next-turn", true);
  }

  /** Queue a follow-up turn (the Web UI's `session.prompt` "queue" mode). */
  followUp(message: UserMessage): void {
    this.deliver(message, "next-turn", true);
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    this.deliver(message, target, wakeup);
  }

  followup(message: UserMessage): void {
    this.deliver(message, "next-turn", true);
  }

  steer(message: UserMessage): void {
    this.deliver(message, "next-step", true);
  }

  inject(message: UserMessage): void {
    this.deliver(message, "next-step", false);
  }

  interrupt(): void {
    // Turn-level interrupt: the session survives, only the in-flight turn stops.
    this.cancel({ kind: "user" }, { keepInbox: true });
  }

  cancel(cause: AgentCancelCause, _options?: CancelOptions): void {
    if (this.disposed) return;
    if (!this.streaming) return;
    if (this.cancelCause === null) this.cancelCause = cause;
    void this.client.interrupt().catch(() => { });
  }

  async whenIdle(): Promise<void> {
    let activity: Promise<void>;
    do {
      activity = this.activityDone;
      await activity;
    } while (activity !== this.activityDone);
  }

  /** Track one in-flight approval so the idle-TTL gate protects a session waiting on a human. */
  async runApproval<T>(task: () => Promise<T>): Promise<T> {
    this.pendingApproval += 1;
    try {
      return await task();
    } finally {
      this.pendingApproval -= 1;
    }
  }

  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return task(new AbortController().signal);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.idleExitTimer);
    this.idleExitTimer = undefined;
    if (this.turnOpen) {
      this.abandonStreamBridge();
      this.closeTurn({ kind: "aborted", reason: { kind: "disposed" } });
    }
    this.markIdle();
    this.endActivity();
    this.client.close();
    resetProjectionState();
    // Release the command mirror explicitly (the agent scope would also dispose
    // it): the registry's own duplicate check makes the release observable.
    const releaseCommands = this.commandsDisposer;
    this.commandsDisposer = undefined;
    this.commandsSignature = "";
    // Session-observed data must not outlive the session (a resumed/next
    // session re-observes it from its own `session_init`).
    this.observedSlashCommands = [];
    try {
      releaseCommands?.();
    } finally {
      await this.scope.dispose();
    }

  }

  // ── internals ────────────────────────────────────────────────────────────

  private deliver(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    if (this.disposed) return;
    const busy = this.turnOpen || this.streaming;
    trace(`deliver target=${target} wakeup=${wakeup} busy=${busy}`);
    if (busy) {
      this.appendUserMessage(message);
      this.scheduleDelivery(async () => {
        const payload = await this.promptContent(message);
        if (payload.kind === "empty") {
          // A steer/followUp is not the turn's own content (unlike the opening
          // prompt), so its notice has fired and the delivery is DROPPED here —
          // never pushed empty, and never allowed to abort a turn the user is
          // actively watching because one image failed to resolve.
          trace(`busy ${target} delivery for turn ${this.dashTurn} has no attachable content — not pushed`);
          return;
        }
        const sent = target === "next-turn" ? this.client.followUp(payload.content) : this.client.steer(payload.content);
        await sent;
      });
      return;
    }
    if (!wakeup) {
      // Idle injection: record it durably and park; a later prompt delivers it.
      this.appendUserMessage(message);
      this.remoteQueue.push({ message, sent: false, transport: "steer" });
      return;
    }
    this.deliverPrompt(message);
  }

  /**
   * Transcode one queued user message into the SDK client's prompt content and
   * REPORT every block that could not be attached.
   *
   * Attachment bytes are read asynchronously HERE — DSH's store is async and
   * returns a `Uint8Array` — into a plain id -> {mediaType, base64} map, and the
   * unchanged pure `toClaudeContent` consumes it as a synchronous lookup. The
   * resulting block array is handed to the client AS-IS: there is no "\n"
   * re-join, so the transcoder's one-block-per-input-block shape reaches the
   * wire intact.
   */
  private async promptContent(message: UserMessage): Promise<PromptPayload> {
    const blocks = dshPromptBlocks(message.content);
    let resolved = new Map<string, ResolvedAttachment>();
    let failures = new Map<string, string>();
    try {
      ({ resolved, failures } = await this.resolveAttachments(message.content));
    } catch (error) {
      // A catastrophic prefetch failure must not abort the turn: report it and
      // continue text-only (the per-block skips below still name every loss).
      this.reportSkippedBlocks([`attachment prefetch failed (${describeError(error)})`]);
    }
    const { content, skipped } = toClaudeContent(blocks, (id) => {
      const hit = resolved.get(id);
      if (hit !== undefined) return hit;
      const failure = failures.get(id);
      // The transcoder contains a throwing reader into a reported skip, so the
      // store's own failure detail survives into the notice.
      if (failure !== undefined) throw new Error(failure);
      return undefined;
    });
    if (content.length === 0 && skipped.length === 0) {
      // `dshPromptBlocks` filtered everything out (no text/image at all, or no
      // content), so the transcoder had nothing to report. Name the loss HERE:
      // this is the one path where content could otherwise vanish silently.
      skipped.push(
        `the message carried no attachable content (${message.content.length} source block(s), none of them text or image)`,
      );
    }
    this.reportSkippedBlocks(skipped);
    if (content.length === 0) {
      // Never synthesize the empty-text block the transcoder refuses to emit.
      // The notice above has fired; the caller fails the turn loudly.
      return { kind: "empty", reason: `no attachable content: ${skipped.join("; ")}` };
    }
    return { kind: "content", content };
  }

  /**
   * Prefetch every durable image attachment one message references, because
   * `toClaudeContent`'s reader is synchronous by contract while the DSH store
   * is async. Every failure mode — a missing service, a malformed ref, a
   * rejecting `readImage`, a non-byte payload, an unusable media type — is
   * recorded with its detail and re-raised through the reader, so each one
   * lands in `skipped` with an actionable reason.
   */
  private async resolveAttachments(
    content: readonly ContentBlock[],
  ): Promise<{ resolved: Map<string, ResolvedAttachment>; failures: Map<string, string> }> {
    const resolved = new Map<string, ResolvedAttachment>();
    const failures = new Map<string, string>();
    const attachments = this.loopCtx.get("attachments") as ClaudeAttachmentsLike | undefined;
    for (const block of content) {
      if (block.type !== "image") continue;
      const ref = block.attachment;
      const id = ref !== null && typeof ref === "object"
        ? stringOf((ref as { attachmentId?: unknown }).attachmentId)
        : undefined;
      if (id === undefined) continue; // malformed ref: the transcoder reports the missing attachmentId
      if (resolved.has(id) || failures.has(id)) continue;
      if (attachments === undefined || typeof attachments.readImage !== "function") {
        failures.set(id, "no attachment service is mounted on the context");
        continue;
      }
      try {
        const stored = await attachments.readImage(ref);
        const data = stored?.data;
        if (!(data instanceof Uint8Array)) {
          failures.set(id, "readImage returned no byte payload");
          continue;
        }
        const mediaType = storedMediaType(stored) ?? stringOf((ref as { mediaType?: unknown }).mediaType);
        if (mediaType === undefined) {
          failures.set(id, "the stored reference carries no mediaType");
          continue;
        }
        resolved.set(id, { mediaType, data: Buffer.from(data).toString("base64") });
      } catch (error) {
        failures.set(id, describeError(error));
      }
    }
    return { resolved, failures };
  }

  /**
   * Serialize async prompt deliveries so a slow attachment read cannot reorder
   * the pushes the client queue preserves FIFO.
   */
  private scheduleDelivery(task: () => Promise<void>): void {
    this.deliveryChain = this.deliveryChain.then(task).catch((error) => { this.fail(error); });
  }

  /**
   * Surface every block the transcoder could not attach. Channel: an always-on
   * stderr warning plus the CLAUDE_TRACE diagnostic. A log-only session event
   * was rejected on purpose — `Session.append` cannot set the envelope's
   * `ignorable` marker, and the persistence read path refuses any event type
   * unknown to this harness that is not ignorable
   * (`@deepseek-ai/dsh-session-persistence` `validateStoredEvents`), so
   * appending a custom notice would make the whole session log unreadable.
   */
  private reportSkippedBlocks(skipped: readonly string[]): void {
    if (skipped.length === 0) return;
    const detail = skipped.join("; ");
    process.stderr.write(`agent-claude: ${skipped.length} content block(s) not attached to the Claude request: ${detail}\n`);
    trace(`content blocks not attached: ${detail}`);
  }

  private deliverPrompt(message: UserMessage): void {
    if (this.disposed) return;
    trace(`deliverPrompt turn=${this.dashTurn + 1} text="${userMessagePreview(message).slice(0, 40)}"`);
    this.reserveTurn();
    clearTimeout(this.idleExitTimer);
    this.idleExitTimer = undefined;
    this.beginActivity();
    this.markRunning();
    // Enter the SAME serialization chain the busy path uses, so a steer that
    // arrives during cold start (after `reserveTurn` flips `turnOpen`) cannot
    // overtake this opening prompt and invert FIFO: the chain slot is taken
    // here, before `startTurn` yields on `ensureStarted`.
    this.scheduleDelivery(() => this.startTurn(message));
  }

  private reserveTurn(): void {
    if (this.turnOpen) return;
    this.dashTurn = ++this.lastTurn;
    this.step = 0;
    this.stepOpen = false;
    this.stepFlushed = false;
    this.turnOpen = true;
  }

  /**
   * Cold-start path for one reserved turn: confirm the client is started,
   * commit the session-identity events (agent-preset + permission stamps),
   * then append turn/start + user/message and dispatch. A failed cold start
   * synthesizes the failed turn (`turn/end{reason:{kind:'error'}}`) rather
   * than hanging, then unwinds the reservation.
   */
  private async startTurn(message: UserMessage): Promise<void> {
    try {
      await this.client.ensureStarted();
      await this.bootstrapSessionIdentity();
    } catch (error) {
      trace(`startTurn cold start failed: ${String(error)}`);
      if (this.turnOpen) {
        this.session.append("turn/start", { turn: this.dashTurn });
        this.appendUserMessage(message);
        this.closeTurn({ kind: "error", error: { message: String(error), code: classifyClaudeError(error) } });
      }
      this.markNotResumableIfDead(error);
      this.markIdle();
      this.endActivity();
      return;
    }
    if (this.disposed) return;
    this.session.append("turn/start", { turn: this.dashTurn });
    // Route metadata for the next request (`request/context`) lands before
    // the turn's messages, exactly as the reference loop stamps it.
    this.emitRequestContext();
    this.appendUserMessage(message);
    // Flush any idle-injection that was parked before this turn.
    for (const entry of this.remoteQueue.splice(0)) {
      this.appendUserMessage(entry.message);
      const parked = await this.promptContent(entry.message);
      if (parked.kind === "empty") {
        // A parked injection is context, not the turn's content: report it
        // (already done) and drop it rather than pushing an empty message or
        // aborting the turn the host actually asked for.
        trace(`parked injection for turn ${this.dashTurn} has no attachable content — not pushed`);
        continue;
      }
      void this.client.steer(parked.content).catch((error) => this.fail(error));
    }
    const payload = await this.promptContent(message);
    if (payload.kind === "empty") {
      // Nothing attachable: never push a blank turn — synthesize the failed
      // turn exactly as a cold-start failure does, after the notice fired.
      this.fail(new Error(payload.reason));
      return;
    }
    void this.client.prompt(payload.content).catch((error) => this.fail(error));
  }

  /**
   * One-shot first-turn identity commit: the agent-preset stamp plus, when
   * the log fold carries no revivable preset, the `permission/preset` event
   * carrying the single-source `claudeMode` and the live `setPermissionMode`
   * re-application.
   *
   * RC-5: the LOG FOLD is the permission authority at first turn. A preset
   * chosen in the blank window (between create and the first prompt) is
   * already folded into `permission/preset` — re-stamping here would bounce
   * the user's choice back to the create-time preset, so BOTH the stamp and
   * the live call are skipped when the fold already carries one (the resume
   * path re-applied the cached mode at client construction).
   */
  private async bootstrapSessionIdentity(): Promise<void> {
    if (this.sessionIdentityCommitted) return;
    this.sessionIdentityCommitted = true;
    if (!this.session.snapshotEvents().some((event) => event.type === "agent-preset/selected" && event.data?.agentPreset === "claude")) {
      this.session.append("agent-preset/selected", { agentPreset: "claude" });
    }
    if (presetFromEvents(this.session.snapshotEvents()) !== undefined) {
      trace("permission/preset already folded into the log — skipping the first-turn re-stamp and mode re-application");
      return;
    }
    const preset = this.runtimeInfo?.preset;
    const claudeMode = this.runtimeInfo?.claudeMode ?? claudePermissionMode(preset);
    if (preset !== undefined) {
      this.session.append("permission/preset", { preset, claudeMode });
      trace(`permission/preset ${preset} -> claudeMode ${claudeMode}`);
    }
    void this.client.setPermissionMode(claudeMode).catch((error) => {
      trace(`setPermissionMode ${claudeMode} failed: ${String(error)}`);
    });
  }

  /**
   * Stamp the session's system prompt once per session as the step's surface
   * node. `system/message` is a step-scoped surface event, so this runs only
   * after `step/start` committed. Skips when the log already carries one
   * (resume) and while no step is open — retried on later steps until the
   * facts are available.
   *
   * Prompt source: the Claude Agent SDK exposes NO system-prompt text to
   * hosts (verified against `SDKSystemMessage` and the initialize response —
   * `systemPrompt` exists only as an outbound Options/request field, and
   * `systemPromptSections` is a /context token report). So the node records
   * clearly-labeled adapter-synthesized FACTS, never a fabricated CLI prompt.
   */
  private emitSystemMessage(): void {
    if (this.systemMessageDone) return;
    if (!this.turnOpen) return;
    this.commitStepStart();
    if (!this.stepOpen) return;
    if (this.session.snapshotEvents().some((event) => event.type === "system/message")) {
      this.systemMessageDone = true;
      return;
    }
    const model = this.observedMessageModel || this.observedDefaultModel || this.options.model || "unknown";
    const mode = this.runtimeInfo?.claudeMode ?? claudePermissionMode(presetFromEvents(this.session.snapshotEvents()));
    const text = [
      "(agent-claude adapter) — session facts synthesized by the adapter.",
      "The Claude Agent SDK does not expose the Claude Code system prompt to hosts, so this node records the resolved runtime facts instead:",
      `- model: ${model}`,
      `- cwd: ${this.client.cwd}`,
      `- permission mode: ${mode}`,
    ].join("\n");
    this.session.append(
      "system/message",
      {
        turn: this.dashTurn,
        step: this.step,
        message: createSystemMessage(text, "aw.agent-adapter-claude"),
      },
      { surfaceOp: "append" },
    );
    this.systemMessageDone = true;
    trace(`system/message stamped (${text.length} chars)`);
  }

  /**
   * Stamp route metadata for the next request (`request/context`): the
   * effective provider/model plus the model's context window when genuinely
   * known. Turn-enclosed (no step required) and deduped by route key.
   */
  private emitRequestContext(): void {
    if (!this.turnOpen) return;
    const model = this.observedMessageModel || this.observedDefaultModel || this.options.model || "";
    if (model === "") return;
    const key = `${CLAUDE_PROVIDER_ID}/${model}`;
    if (key === this.lastRouteKey) return;
    this.lastRouteKey = key;
    const entry = readModelCatalog().models.find((candidate) => candidate.id === model);
    const contextWindow = entry?.contextWindow;
    this.session.append("request/context", {
      provider: CLAUDE_PROVIDER_ID,
      model,
      ...(contextWindow !== undefined && contextWindow > 0 ? { contextWindow } : {}),
    });
    trace(`request/context ${key}${contextWindow === undefined ? "" : ` ctx=${contextWindow}`}`);
  }

  /** The open stream bridge for this message, starting one on first use. */
  private ensureStreamBridge(): AssistantStreamBridge {
    if (this.streamBridge === undefined || this.streamBridge.ended) {
      this.streamBridge = new AssistantStreamBridge(
        this.session.id,
        ++this.assistantAttemptCounter,
        () => ++this.assistantStreamRevision,
        (frame) => this.dispatch.emit("agent/assistant-stream", { frame }),
      );
      this.streamBridge.start(this.dashTurn, this.step);
    }
    return this.streamBridge;
  }

  /** Abandon any open stream bridge — failure paths never settle. */
  private abandonStreamBridge(): void {
    if (this.streamBridge !== undefined && !this.streamBridge.ended) this.streamBridge.abandon();
    this.streamBridge = undefined;
  }

  /** Capture the usage/model an assistant wire event reported (RC-6). */
  private captureProvenance(event: WireEvent): void {
    if (typeof event.model === "string" && event.model !== "") this.observedMessageModel = event.model;
    const usage = convertUsage(event.usage);
    if (usage !== undefined) this.capturedUsage = usage;
  }

  /**
   * Close the current step after its attempt was already flushed, so the next
   * assistant message opens a fresh attempt step (the turn-usage fold needs
   * exactly one usage sample per step). No-op unless a flushed message is
   * actually open.
   */
  private closeAttemptStep(): void {
    if (!this.turnOpen || !this.stepOpen || !this.stepFlushed) return;
    this.session.append("step/end", { turn: this.dashTurn, step: this.step });
    // Keep the COUNTER: steps within one turn number 1, 2, 3, … (the r1 code
    // reset it to 0 here, so every step of a multi-step turn was numbered 1 —
    // duplicate (turn, step) coordinates corrupted the Web transcript replay,
    // live-found 2026-09-18).
    this.stepOpen = false;
    this.stepFlushed = false;
  }

  private appendUserMessage(message: UserMessage): void {
    this.session.append("user/message", message, { surfaceOp: "append" });
  }

  /** Open the step lazily before the first step-scoped event of the turn. */
  private commitStepStart(): void {
    if (!this.turnOpen || this.stepOpen) return;
    this.step += 1;
    this.stepOpen = true;
    this.stepFlushed = false;
    this.session.append("step/start", { turn: this.dashTurn, step: this.step });
    trace(`step/start turn=${this.dashTurn} step=${this.step}`);
    // The system prompt is stamped inside the first OPEN step of the session
    // (the node precedes the step's messages, mirroring the reference loop).
    this.emitSystemMessage();
  }

  private commitStepEnd(): void {
    if (!this.turnOpen || !this.stepOpen) return;
    this.session.append("step/end", { turn: this.dashTurn, step: this.step });
    this.stepOpen = false;
  }

  private closeTurn(reason: TurnEndReason): void {
    if (!this.turnOpen) return;
    this.turnOpen = false;
    this.session.append("turn/end", { turn: this.dashTurn, reason });
  }

  /**
   * Flush buffered reasoning/text as one `assistant/message` (the attempt's
   * durable settlement), then reset. The sample rides the SAME event (RC-6):
   * the explicit `usage` wins, else the latest assistant-message usage the
   * projection carried — so the `tool_start` flush lands a same-attempt
   * sample and nothing ever stashes across turns.
   */
  private flushAssistant(usage?: TokenUsage): void {
    if (this.reasoningBuffer === "" && this.textBuffer === "") {
      if (usage !== undefined) trace("flush had usage but no buffered content — sample dropped (no message carries it)");
      return;
    }
    const blocks: ContentBlock[] = [];
    if (this.reasoningBuffer !== "") blocks.push({ type: "reasoning", text: this.reasoningBuffer });
    if (this.textBuffer !== "") blocks.push({ type: "text", text: this.textBuffer });
    this.reasoningBuffer = "";
    this.textBuffer = "";
    const effectiveUsage = usage ?? this.capturedUsage;
    this.capturedUsage = undefined;
    this.commitStepStart();
    const bridge = this.streamBridge;
    const assistant: AssistantMessage = createAssistantMessage({
      content: blocks,
      // The OBSERVED model (what the CLI actually ran), not the requested one.
      source: { provider: CLAUDE_PROVIDER_ID, model: this.observedMessageModel || this.observedDefaultModel || this.options.model || "" },
    });
    const event = this.session.append("assistant/message", {
      turn: this.dashTurn,
      step: this.step,
      message: assistant,
      stream: bridge?.records ?? [],
      ...(effectiveUsage === undefined ? {} : { usage: effectiveUsage }),
    }, {
      surfaceOp: "append",
    });
    this.stepFlushed = true;
    if (bridge !== undefined && !bridge.ended) bridge.settle(event.seq);
    this.streamBridge = undefined;
  }

  private appendToolCall(callId: string, name: string, args: unknown): void {
    this.commitStepStart();
    this.session.append("tool/call", {
      turn: this.dashTurn,
      step: this.step,
      callId: ToolCallId(callId),
      name,
      arguments: JSON.stringify(args ?? {}),
    });
  }

  private appendToolResult(callId: string, content: string, isError: boolean): void {
    this.commitStepStart();
    const message = createToolResultMessage({
      callId: ToolCallId(callId),
      content: content === "" ? [] : [{ type: "text", text: content }],
      isError,
    });
    this.session.append("tool/result", {
      turn: this.dashTurn,
      step: this.step,
      message,
      ...(isError ? { error: { name: "ToolExecutionError", code: "TOOL_ERROR" } } : {}),
    }, {
      surfaceOp: "append",
    });
  }

  /**
   * Feed the observed model into the catalog: the degraded `session_init.model`
   * read immediately, then the full `supportedModels()` list replaces it.
   */
  private observeModelCatalog(init: WireEvent): void {
    if (typeof init.model === "string" && init.model !== "") this.observedDefaultModel = init.model;
    const entries = catalogFromInit(init as { model?: unknown; slashCommands?: unknown });
    if (entries.length > 0) setModelCatalog(entries, this.observedDefaultModel);
    void this.client.supportedModels().then((models) => {
      const full = Array.isArray(models) ? models.flatMap((m) => modelEntryFromSdk(m)) : [];
      if (full.length > 0) setModelCatalog(full, this.observedDefaultModel);
    }).catch((error) => {
      trace(`supportedModels() failed: ${String(error)}`);
    });
  }

  /**
   * Learn Claude's command surface for this session: the degraded
   * `session_init.slash_commands` name list immediately (same two-stage shape as
   * the model catalog above), then the authoritative `supportedCommands()` list
   * — which carries each command's description and argument hint — replaces it.
   * Both stages end in {@link syncClaudeCommands}, so a session that reports
   * nothing lands zero registrations rather than throwing.
   */
  private observeSlashCommands(init: WireEvent): void {
    this.observedSlashCommands = slashCommandsFromReported(init.slashCommands);
    trace(`observed ${this.observedSlashCommands.length} Claude slash command(s) from session_init`);
    this.syncClaudeCommands();
    const fetchSupported = this.client.supportedCommands;
    if (typeof fetchSupported !== "function") return;
    void fetchSupported.call(this.client).then((commands) => {
      const full = slashCommandsFromReported(commands);
      if (full.length === 0) return;
      this.observedSlashCommands = full;
      trace(`observed ${full.length} Claude slash command(s) from supportedCommands()`);
      this.syncClaudeCommands();
    }).catch((error) => {
      trace(`supportedCommands() failed: ${String(error)}`);
    });
  }

  /** Adopt the agent-scoped commands registry and build the mirror against it. */
  private attachCommandRuntime(runtime: CommandRuntime): void {
    this.commandsAccessor = { commands: runtime };
    // `inject` re-runs when the service is replaced: the previous mirror lived
    // on the previous registry instance (and was disposed with it), so forgetting
    // the signature forces a rebuild instead of an early return.
    this.commandsSignature = "";
    this.commandsDisposer = undefined;
    this.syncClaudeCommands();
  }

  /**
   * Keep the agent-scoped command mirror equal to the observed list.
   *
   * Rebuilds only when the observed surface actually changed, and always
   * releases the previous mirror BEFORE registering the new one: the registry
   * rejects a duplicate name inside one scope layer, so a rebuild that
   * registered first would throw on its own names.
   */
  private syncClaudeCommands(): void {
    const accessor = this.commandsAccessor;
    if (accessor === undefined || this.disposed) {
      // No commands service in this world: the adapter simply has no mirror.
      return;
    }
    const signature = this.observedSlashCommands
      .map((command) => `${command.name}\u0000${command.description ?? ""}\u0000${command.argumentHint ?? ""}`)
      .join("\u0001");
    if (signature === this.commandsSignature) return;
    this.commandsSignature = signature;
    const previous = this.commandsDisposer;
    this.commandsDisposer = undefined;
    previous?.();
    if (this.observedSlashCommands.length === 0) return;
    try {
      this.commandsDisposer = registerClaudeCommands(accessor, {
        listSlashCommands: () => this.observedSlashCommands,
        submit: (agent, line) => { this.submitClaudeLine(agent, line); },
      });
    } catch (error) {
      // A rejected mirror must not pin the signature (a later observation would
      // then skip the retry); the client's listener containment reports it loud.
      this.commandsSignature = "";
      throw error;
    }
    trace(`mirrored ${this.observedSlashCommands.length} Claude command(s) onto ctx.commands`);
  }
  /**
   * Deliver one forwarded Claude slash line to THIS session.
   *
   * The mirror is registered on this agent's scope, so the invocation's agent is
   * always this instance; the identity guard makes a misrouted invocation a
   * loud no-op instead of driving another session's CLI. The line becomes an
   * ordinary user turn (`prompt`): it queues behind an open turn and opens one
   * when idle, so Claude's own slash-command handling sees the exact line and
   * the output lands in the transcript like any other turn.
   */
  private submitClaudeLine(agent: unknown, line: string): void {
    if (agent !== this) {
      trace(`claude command "${line}" arrived for a foreign agent — dropped`);
      return;
    }
    trace(`forwarding "${line}" to Claude`);
    this.prompt(createUserMessage({ content: [{ type: "text", text: line }], source: { kind: "user" } }));
  }

  private handleEvent(event: WireEvent): void {
    switch (event.type) {
      case "session_init":
        trace(`session_init model=${String(event.model)}`);
        this.observeModelCatalog(event);
        this.observeSlashCommands(event);
        break;

      case "assistant_reasoning":
      case "assistant_text": {
        // One COMPLETE SDK assistant message (no deltas): capture its
        // usage/model, make the text visible NOW via one bridge chunk (it
        // must precede the first tool_start flush), and buffer it for the
        // durable flush.
        const text = typeof event.text === "string" ? event.text : "";
        this.captureProvenance(event);
        if ((event.parentToolUseId ?? null) === null) {
          // A new main-thread assistant message after this step's attempt was
          // already flushed (tool round completed) opens the NEXT attempt's
          // step — the turn-usage fold needs one assistant/message per step.
          if (this.stepFlushed) this.closeAttemptStep();
          const bridge = this.ensureStreamBridge();
          if (text !== "") {
            bridge.push(event.type === "assistant_text"
              ? { type: "text-delta", index: 0, text }
              : { type: "reasoning-delta", index: 0, text });
          }
        }
        if (event.type === "assistant_reasoning") this.reasoningBuffer += text;
        else this.textBuffer += text;
        break;
      }

      case "assistant_message":
        // A raw assistant body with no recognized text/reasoning/tool block.
        trace("assistant_message (unrecognized body) ignored");
        break;

      case "tool_start": {
        const callId = String(event.callId ?? "");
        const name = String(event.name ?? "tool");
        const parent = event.parentToolUseId ?? null;
        if (parent !== null) this.subagentCount += 1;
        // RC-6: the mid-turn flush closes the attempt WITH the sample the
        // message itself reported (captured above / on the assistant events).
        this.captureProvenance(event);
        this.flushAssistant();
        this.appendToolCall(callId, name, event.arguments);
        break;
      }

      case "tool_end": {
        const callId = String(event.callId ?? "");
        const parent = event.parentToolUseId ?? null;
        if (parent !== null) this.subagentCount = Math.max(0, this.subagentCount - 1);
        const isError = event.isError === true;
        const content = typeof event.content === "string" ? event.content : "";
        this.appendToolResult(callId, content, isError);
        break;
      }

      case "turn_end": {
        trace(`turn_end isError=${String(event.isError)} stopReason=${String(event.stopReason)}`);
        // Last chance for the system prompt (appended inside the still-open
        // step, before step/end, so the step-scope invariant holds).
        this.emitSystemMessage();
        const usage = convertUsage(event.usage);
        this.flushAssistant(usage);
        this.commitStepEnd();
        const cancelCause = this.cancelCause;
        this.cancelCause = null;
        this.closeTurn(
          cancelCause !== null
            ? { kind: "aborted", reason: cancelCause }
            : event.isError === true
              ? { kind: "error", error: { message: "Claude turn failed", code: classifyClaudeError(event.error) } }
              : { kind: "completed" },
        );
        this.markIdle();
        this.endActivity();
        break;
      }

      case "todo_write": {
        // Log-only whole-list snapshot (latest-wins); the tool pair already
        // rode the same assistant message.
        const todos = Array.isArray(event.todos) ? event.todos : [];
        try {
          this.session.append("todo/write", { todos });
          trace(`todo/write ${todos.length} item(s)`);
        } catch (error) {
          trace(`todo/write failed: ${String(error)}`);
        }
        break;
      }

      case "compaction": {
        // The CLI's compact_boundary reports an ALREADY-COMPLETE compaction:
        // emit the DSH bracket (start+end, standalone owner when no turn is
        // open) so the vocabulary folds instead of staying trace-only.
        const compactionId = randomUUID();
        const ownerTurn = this.turnOpen ? this.dashTurn : null;
        try {
          this.session.append("compaction/start", { compactionId, turn: ownerTurn });
          this.session.append("compaction/end", { compactionId, turn: ownerTurn });
          trace(`compaction bracket ${compactionId} (turn=${String(ownerTurn)}) metadata=${JSON.stringify(event.metadata)}`);
        } catch (error) {
          trace(`compaction bracket failed: ${String(error)}`);
        }
        break;
      }

      case "compaction":
        // V1 gap: the dsh-compaction event vocabulary is not referenced here.
        trace(`compaction boundary (log-only): ${JSON.stringify(event.metadata)}`);
        break;

      case "permission_denied":
        trace(`permission_denied (log-only): ${String(event.toolName)} ${String(event.reasonType)}`);
        break;

      case "refusal_fallback": {
        const uuids = Array.isArray(event.retractedMessageUuids) ? event.retractedMessageUuids : [];
        trace(`refusal_fallback: retracted=${JSON.stringify(uuids)} original=${String(event.originalModel)} fallback=${String(event.fallbackModel)}`);
        const blocks = refusalBlocks(event.content);
        if (blocks.length > 0) {
          this.commitStepStart();
          const assistant: AssistantMessage = createAssistantMessage({
            content: blocks,
            source: { provider: CLAUDE_PROVIDER_ID, model: String(event.fallbackModel ?? this.options.model ?? "") },
          });
          this.session.append("assistant/message", {
            turn: this.dashTurn,
            step: this.step,
            message: assistant,
            stream: [],
          }, { surfaceOp: "append" });
        }
        break;
      }

      case "refusal_no_fallback":
        trace(`refusal_no_fallback (log-only): ${String(event.originalModel)} ${String(event.category)}`);
        break;

      case "local_command_output":
        trace(`local_command_output (log-only): ${String(event.content).slice(0, 120)}`);
        break;

      case "agent_end": {
        const isError = event.isError === true;
        const error = typeof event.error === "string" ? event.error : undefined;
        if (this.turnOpen) {
          this.flushAssistant();
          this.commitStepEnd();
          const cancelCause = this.cancelCause;
          this.cancelCause = null;
          this.closeTurn(
            cancelCause !== null
              ? { kind: "aborted", reason: cancelCause }
              : isError
                ? { kind: "error", error: { message: error ?? "Claude session ended with an error", code: classifyClaudeError(error) } }
                : { kind: "completed" },
          );
        }
        this.markIdle();
        this.endActivity();
        break;
      }

      default:
        // Unknown wire shapes are ignored, never an error (Task 9 hazard 2).
        break;
    }
  }

  private fail(error: unknown): void {
    if (this.disposed) return;
    trace(`fail ${String(error).slice(0, 200)}`);
    // Failure paths never settle a stream attempt.
    this.abandonStreamBridge();
    if (this.turnOpen) {
      this.flushAssistant();
      this.commitStepEnd();
      this.closeTurn({ kind: "error", error: { message: String(error), code: classifyClaudeError(error) } });
    }
    this.markNotResumableIfDead(error);
    this.markIdle();
    this.endActivity();
  }

  /** A conversation-not-found failure is terminal for the pairing (2026-09-18):
   *  mark the map record dead once so later prompts fail fast at resume. */
  private markNotResumableIfDead(error: unknown): void {
    if (this.notResumableMarked || classifyClaudeError(error) !== "CONVERSATION_NOT_FOUND") return;
    this.notResumableMarked = true
    try {
      this.runtimeInfo?.onNotResumable?.()
    } catch (error) {
      trace(`mark not resumable failed: ${String(error)}`);
    }
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

  private markRunning(): void {
    clearTimeout(this.idleExitTimer);
    this.idleExitTimer = undefined;
    if (this.streaming) return;
    this.streaming = true;
    this.dispatch.emit("agent/status", { status: "running" });
  }

  private markIdle(): void {
    if (!this.streaming) return;
    this.streaming = false;
    this.dispatch.emit("agent/status", { status: "idle" });
    this.armIdleExit();
  }

  private armIdleExit(): void {
    if (this.disposed || this.onIdleExit === undefined || CLAUDE_IDLE_EXIT_MS === 0) return;
    if (this.remoteQueue.some((entry) => !entry.sent)) return;
    clearTimeout(this.idleExitTimer);
    this.idleExitTimer = setTimeout(() => {
      this.idleExitTimer = undefined;
      void this.revalidateIdleExit();
    }, CLAUDE_IDLE_EXIT_MS);
    this.idleExitTimer.unref?.();
  }

  /**
   * Quiescence re-validation at fire time. The idle timer is only a hint:
   * before teardown, re-confirm no live work via local signals. Any busy
   * signal re-arms; a never-spawned draft is abandoned outright (no re-arm).
   */
  private async revalidateIdleExit(): Promise<void> {
    if (this.disposed || this.streaming) return this.armIdleExit();
    if (!this.client.spawned) {
      trace(`idle exit: never-spawned draft ${this.id} — abandoning without re-arm`);
      this.onIdleExit?.();
      return;
    }
    if (this.remoteQueue.some((entry) => !entry.sent)) return this.armIdleExit();
    if (this.pendingApproval > 0) return this.armIdleExit();
    // The client self-reports it is still running (a turn in flight) — re-arm.
    try {
      const state = await this.client.getState();
      if (state.isStreaming) return this.armIdleExit();
    } catch {
      // Self-attestation unavailable: local signals remain authoritative.
    }
    if (this.subagentCount > 0) return this.armIdleExit();
    trace(`idle exit after ${CLAUDE_IDLE_EXIT_MS}ms — disposing agent ${this.id}`);
    this.onIdleExit?.();
  }
}
