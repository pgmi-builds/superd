/**
 * Hermes TUI-gateway event → omp wire vocabulary projection (AW-H Task 2).
 *
 * The wire vocabulary is the same internal `Wire*` vocabulary as
 * agent-codex/src/codex-events.ts (ported from agent-omp/src/rpc-types.ts);
 * the omp event `type` STRINGS are kept verbatim (`agent_start` / `turn_start`
 * / `message_start` / `message_update` / `message_end` /
 * `tool_execution_start` / `tool_execution_end` / `turn_end` / `agent_end`)
 * so the Task 7 agent.ts port consumes the exact same switch it consumes on
 * the codex line.
 *
 * The projector is a PURE function `projectGatewayEvent(type, payload, ctx)`:
 * no I/O, no timers, no module state. Accumulation (open assistant text,
 * thinking buffer, seen tool ids) is the CLIENT's job — the read-only
 * `ProjectionCtx { turnOpen, openAssistant }` is the client's per-frame
 * answer to the only two questions the projection needs state for.
 *
 * Projection mapping (as-built; grounded in the Task 1 live fixture
 * `agent-hermes/spike-events@1` + gateway source pins):
 *
 *   message.start (no payload key)     → turn open: [agent_start, turn_start,
 *                                        message_start(assistant, [])]; turn
 *                                        already open: message_start alone.
 *                                        Hermes has NO thread.started /
 *                                        turn.started events — message.start
 *                                        IS the live-pinned turn-open bracket
 *                                        (Task 1 §9.2 ①), gated on
 *                                        !ctx.turnOpen so repeats stay bare.
 *   message.delta {text}               → message_update(assistantMessageEvent
 *                                        { type:"text_delta", contentIndex:0,
 *                                        delta }) — healed with a leading
 *                                        message_start when !ctx.openAssistant.
 *   thinking.delta {text}              → null (incl. empty-string frames —
 *   reasoning.delta {text, verbose?}   →  live display is the client's
 *                                        accumulation; the durable thinking
 *                                        block rides message.complete.reasoning)
 *   tool.start {tool_id, name,         → tool_execution_start {toolCallId,
 *     context, args?, args_text?}        toolName, args, argumentsJson }
 *                                        (id field is `tool_id` — Task 1 §3④
 *                                        correction; args_text, when present,
 *                                        is the RAW JSON string and wins)
 *   tool.complete {tool_id, name,      → tool_execution_end {toolCallId,
 *     args, result, duration_s?,         toolName, result:{content,isError},
 *     summary?, inline_diff?, …}         isError, duration_s? } — result is a
 *                                        parsed-JSON value or raw string;
 *                                        objects render as pretty JSON text,
 *                                        strings verbatim, summary is the
 *                                        fallback. isError is ALWAYS false in
 *                                        V1: the gateway pins no error/status
 *                                        field on tool.complete.
 *   message.complete {text, usage,     → [message_end, turn_end, agent_end]
 *     status:"complete", reasoning?}     — message_end carries the text block
 *                                        (+ trailing thinking block from
 *                                        `reasoning`) and the RAW hermes usage
 *                                        verbatim at `usage` (brief table);
 *                                        turn_end carries the same usage at
 *                                        `data.usage` (the agent.ts seam —
 *                                        codex parity) plus `data.status`;
 *                                        agent_end closes the run.
 *   message.complete {status:"error",  → same terminal triple, with
 *     error, recoverable, partial?, …}   message_end {stopReason:"error",
 *                                        errorMessage, content from `partial`}
 *                                        (failure classification stays in
 *                                        agent.ts's wireFailure, unchanged)
 *   message.complete                   → same triple, plain message_end with
 *     {status:"interrupted", …}          the partial text; the interrupt
 *                                        intent itself reaches the client via
 *                                        its own cancel path, not the wire.
 *   error {message}                    → agent_end (data.error.message),
 *                                        ONLY while ctx.turnOpen — abnormal
 *                                        finish with no message.complete.
 *   session.info (running true/false),   } null — log-only. The settled pair
 *   session.usage, status.update,        } message.complete →
 *   approval.request,                    } session.info(running=false) is the
 *   sessions.changed,                    } CLIENT's turn-boundary signal
 *   gateway.ready, message.interim,      } (Task 1 §9.2), never wire.
 *   session.title {session_id, title}   → session_title {name} (pi wire
 *                                        parity) — the AGENT mirrors it as
 *                                        `session/title` (provider source);
 *                                        empty/missing titles stay null.
 *   todo.updated {todos, revision}      → todo_updated {todos: DSH-shaped
 *                                        [{content, status}]} — the AGENT
 *                                        appends the log-only `todo/write`
 *                                        whole-list snapshot. Items map:
 *                                        trimmed non-empty content, status
 *                                        ∈ {pending, in_progress, completed};
 *                                        `cancelled`/unknown-status and
 *                                        duplicate-content items are dropped
 *                                        (DSH's todo/write invariant has no
 *                                        cancelled status and forbids
 *                                        repeated content). A well-formed
 *                                        empty list passes through — a real
 *                                        clear (revision ≥ 1 per gateway).
 *   anything unrecognized                 }
 *
 * KNOWN SEAM (documented for Task 3): gateway tool-frame emission is
 * CONDITIONAL and the gates differ between start and complete (server.py:
 * _on_tool_start requires progress-enabled ∥ lifecycle-required-for-ui;
 * _on_tool_complete additionally fires for inline_diff ∥ todo tools) — so an
 * orphan tool.complete without a prior tool.start is possible. The projector
 * cannot dedup/pair without state (purity contract); the CLIENT, which owns
 * accumulation state, should synthesize the missing tool_execution_start for
 * an unseen toolCallId before forwarding the end.
 *
 * Never throws: any internal failure collapses to `null` (fail-soft).
 */

/** One wire event record streamed to client listeners (omp RpcEvent shape). */
export interface WireEvent {
  type: string;
  [key: string]: unknown;
}

/** One content block inside a wire message — text | thinking | toolCall (omp OmpContentBlock shape). */
export interface WireContentBlock {
  type: string;
  [key: string]: unknown;
}

/** One DSH-shaped todo item on a todo_updated wire event (upstream tool-todo TodoItem). */
export interface WireTodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

/** A wire message (user | assistant | toolResult) (omp OmpMessage shape). */
export interface WireMessage {
  content?: WireContentBlock[];
  [key: string]: unknown;
}

/** The assistantMessageEvent delta carried by a message_update event (omp OmpAssistantMessageEvent shape). */
export interface WireAssistantMessageEvent {
  type: string;
  contentIndex?: number;
  delta?: string;
  content?: string;
  partial?: unknown;
  toolCall?: unknown;
}

/**
 * Read-only projection context owned by the client (Task 3). `turnOpen`:
 * a gateway turn is currently open (message.start seen / message.complete
 * not yet); `openAssistant`: an assistant aggregation window is open.
 */
export interface ProjectionCtx {
  turnOpen: boolean;
  openAssistant: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function assistantMessageStart(): WireEvent {
  return { type: "message_start", message: { role: "assistant", content: [] } };
}

function textDelta(delta: string): WireEvent {
  const assistantMessageEvent: WireAssistantMessageEvent = { type: "text_delta", contentIndex: 0, delta };
  return { type: "message_update", assistantMessageEvent };
}

/** Render a tool.complete `result` (parsed JSON value or raw string) as the wire result text. */
function renderToolResult(payload: Record<string, unknown>): string {
  const result = payload.result;
  if (typeof result === "string") return result;
  if (result !== null && result !== undefined) {
    const rendered = JSON.stringify(result, null, 2);
    if (typeof rendered === "string") return rendered;
  }
  return asText(payload.summary);
}

/**
 * message.complete — the turn-terminal event (Task 1 §9.2 ①). Emits the
 * terminal triple [message_end, turn_end, agent_end] for every status
 * ("complete" | "interrupted" | "error"): the wire run bracket that
 * agent_start/turn_start opened at message.start closes here.
 */
function messageComplete(p: Record<string, unknown>): WireEvent[] {
  const status = asText(p.status);
  const usage = asRecord(p.usage);
  const content: WireContentBlock[] = [];
  const message: WireMessage = { role: "assistant", content };
  if (status === "error") {
    const partial = asText(p.partial);
    if (partial !== "") content.push({ type: "text", text: partial });
    message.stopReason = "error";
    const error = asText(p.error);
    if (error !== "") message.errorMessage = error;
  } else {
    content.push({ type: "text", text: asText(p.text) });
    const reasoning = asText(p.reasoning);
    if (reasoning !== "") content.push({ type: "thinking", thinking: reasoning });
  }
  const end: WireEvent = { type: "message_end", message };
  if (usage !== null) end.usage = usage;
  const data: Record<string, unknown> = {};
  if (usage !== null) data.usage = usage;
  if (status !== "") data.status = status;
  const turnEnd: WireEvent = Object.keys(data).length === 0 ? { type: "turn_end" } : { type: "turn_end", data };
  return [end, turnEnd, { type: "agent_end" }];
}

/**
 * Project one Hermes gateway event frame (duck-typed: the client passes
 * `params.type` and `params.payload` — payload is OPTIONAL, `message.start`
 * carries none) onto the omp wire vocabulary. Returns one event, an ordered
 * array, or null for ignorable/malformed input. Never throws.
 */
export function projectGatewayEvent(type: string, payload: unknown, ctx: ProjectionCtx): WireEvent | WireEvent[] | null {
  try {
    if (typeof type !== "string") return null;
    const turnOpen = ctx !== null && typeof ctx === "object" && (ctx as ProjectionCtx).turnOpen === true;
    const openAssistant = ctx !== null && typeof ctx === "object" && (ctx as ProjectionCtx).openAssistant === true;
    switch (type) {
      case "message.start": {
        // Turn-open bracket: no payload key exists on this frame.
        const start = assistantMessageStart();
        return turnOpen ? start : [{ type: "agent_start" }, { type: "turn_start" }, start];
      }
      case "message.delta": {
        const p = asRecord(payload);
        if (p === null) return null;
        const update = textDelta(asText(p.text));
        return openAssistant ? update : [assistantMessageStart(), update];
      }
      case "thinking.delta":
      case "reasoning.delta":
        // Folded into the final message_end via message.complete.reasoning;
        // live display is the client's accumulation. Never wire.
        return null;
      case "tool.start": {
        const p = asRecord(payload);
        if (p === null) return null;
        const args = asRecord(p.args) ?? {};
        // args_text (verbose sessions) is the RAW string — keep it verbatim,
        // mirroring codex's raw mcp argumentsJson seam.
        const argumentsJson = typeof p.args_text === "string" ? p.args_text : JSON.stringify(args);
        return {
          type: "tool_execution_start",
          toolCallId: asText(p.tool_id),
          toolName: asText(p.name),
          args,
          argumentsJson,
        };
      }
      case "tool.complete": {
        const p = asRecord(payload);
        if (p === null) return null;
        const end: WireEvent = {
          type: "tool_execution_end",
          toolCallId: asText(p.tool_id),
          toolName: asText(p.name),
          result: { content: [{ type: "text", text: renderToolResult(p) }], isError: false },
          isError: false,
        };
        if (typeof p.duration_s === "number") end.duration_s = p.duration_s;
        return end;
      }
      case "message.complete": {
        const p = asRecord(payload);
        if (p === null) return null;
        return messageComplete(p);
      }
      case "error": {
        const p = asRecord(payload);
        if (p === null || !turnOpen) return null; // abnormal finish, only mid-turn
        const message = asText(p.message);
        return message === "" ? { type: "agent_end" } : { type: "agent_end", data: { error: { message } } };
      }
      case "session.title": {
        // Gateway-owned title → session_title wire event; the AGENT mirrors it
        // as `session/title` (pi pattern). Empty/missing titles stay null.
        const p = asRecord(payload);
        const title = typeof p?.title === "string" ? p.title : "";
        return title === "" ? null : { type: "session_title", name: title };
      }
      case "todo.updated": {
        // Whole-list todo snapshot {todos, revision} → todo_updated with
        // DSH-shaped items; the AGENT appends the log-only `todo/write`.
        // Mapping: trimmed non-empty content; status ∈ {pending, in_progress,
        // completed} (gateway `cancelled`/unknown statuses drop); duplicate
        // content drops (the DSH todo/write invariant forbids repeats). A
        // well-formed empty list passes through — a real clear (revision ≥ 1).
        const p = asRecord(payload);
        if (p === null || !Array.isArray(p.todos)) return null;
        const todos: WireTodoItem[] = [];
        const seenContent = new Set<string>();
        for (const item of p.todos) {
          if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
          const raw = item as Record<string, unknown>;
          const content = typeof raw.content === "string" ? raw.content.trim() : "";
          if (content === "" || seenContent.has(content)) continue;
          const status = raw.status;
          if (status !== "pending" && status !== "in_progress" && status !== "completed") continue;
          seenContent.add(content);
          todos.push({ content, status });
        }
        return { type: "todo_updated", todos };
      }
      default:
        // session.info / session.usage / status.update /
        // approval.request / sessions.changed /
        // gateway.ready / message.interim / unknown → ignorable (S5).
        return null;
    }
  } catch {
    return null;
  }
}
