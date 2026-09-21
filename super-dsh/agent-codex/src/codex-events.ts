/**
 * Codex SDK ThreadEvent → omp wire vocabulary projection (AW-E Task 2).
 *
 * The wire vocabulary is ported from agent-omp/src/rpc-types.ts and renamed to
 * codex-internal `Wire*` types; the omp event `type` STRINGS are kept verbatim
 * (`agent_start` / `turn_start` / `message_start` / `message_update` /
 * `message_end` / `tool_execution_start` / `tool_execution_end` / `turn_end` /
 * `text_delta` / `agent_end`) so the Task 7 agent.ts port consumes the exact
 * same switch it consumes on the omp line.
 *
 * Projection mapping (as implemented; `agent_end` is NOT produced here — the
 * client emits it when a run stream settles, mirroring the omp sidecar):
 *
 *   thread.started                          → agent_start (data.threadId)
 *   turn.started                            → turn_start
 *   item.started  agent_message             → message_start (assistant, [])
 *                                             + message_update(text_delta) when
 *                                             the start already carries text
 *   item.started  reasoning                 → message_start (assistant, [thinking])
 *   item.started  *tool items*              → tool_execution_start
 *   item.updated  agent_message (growth)    → message_update(assistantMessageEvent
 *                                             { type: "text_delta", delta: growth })
 *   item.updated  reasoning                 → null (folded into the final thinking
 *                                             block — omp folds thinking_* too)
 *   item.updated  tool items (terminal)     → tool_execution_end
 *   item.completed agent_message            → message_end (assistant, [text])
 *   item.completed reasoning                → message_end (assistant, [thinking])
 *   item.completed command_execution        → tool pair; status in_progress →
 *                                             start, completed/failed → end; the
 *                                             end carries command /
 *                                             aggregated_output / exit_code
 *   item.completed mcp_tool_call            → tool pair (toolName = item.tool,
 *                                             args = item.arguments, server key)
 *   item.completed file_change              → tool pair (rendered changes)
 *   item.completed web_search               → tool pair (query)
 *   item.completed todo_list                → tool pair (rendered checklist)
 *   item.completed error item               → message_end stopReason "error"
 *   item.completed todo_list                → tool pair (rendered checklist)
 *                                             + todo_write (DSH `todo/write`
 *                                             whole-list snapshot, log-only,
 *                                             latest-wins — upstream
 *                                             packages/todo/tool-todo)
 *                                             Usage, verbatim — conversion to
 *                                             Dash TokenUsage is Task 7's job)
 *   turn.failed                             → turn_end (data.error raw payload)
 *   error (fatal stream event)              → null — the client reports failure
 *                                             via onFailure, not the event stream
 *   anything unrecognized / malformed       → null (ignorable, S5 invariant)
 *
 * DESIGN CHOICE — `item.updated` text deltas: the omp vocabulary streams live
 * text as `message_update` events whose `assistantMessageEvent` payload carries
 * `{ type: "text_delta", contentIndex, delta }` (agent-omp/src/agent.ts
 * #handleUpdate consumes exactly that shape; a TOP-LEVEL `text_delta` event is
 * in the plan's vocabulary list but has no consumer in agent.ts's switch, so
 * projecting into `message_update` is the seam that survives the Task 7 port).
 * Codex `item.updated` snapshots the FULL item text, while the wire wants
 * per-update growth, so the projector keeps a watermark (item id → last
 * emitted text) and emits the difference; a non-prefix snapshot re-emits the
 * full text defensively (the durable transcript comes from `message_end`
 * anyway — deltas are presentation-only).
 *
 * DESIGN CHOICE — tool item dedup: codex emits `item.started` when a tool call
 * is dispatched and `item.completed` when it settles, but minimal/short chains
 * (the Task 1 fixture shape) skip `item.started`. A started-items watermark
 * makes the start event fire exactly once per item: completed-after-started →
 * end only; completed-without-started → full start+end pair. agent.ts appends
 * one tool/call per start and one tool/result per end, so this keeps the Dash
 * transcript free of duplicates.
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

/** A wire message (user | assistant | toolResult) (omp OmpMessage shape). */
export interface WireMessage {
  role: "user" | "assistant" | "toolResult";
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

/** Watermark of streamed agent_message text (item id → last emitted full text). */
const textWatermark = new Map<string, string>();
/** Items whose tool_execution_start already fired (id → true). */
const startedTools = new Set<string>();

/** Reset the projection watermarks (test / new-session hygiene). */
export function resetProjectionState(): void {
  textWatermark.clear();
  startedTools.clear();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function textDelta(delta: string): WireEvent {
  const assistantMessageEvent: WireAssistantMessageEvent = { type: "text_delta", contentIndex: 0, delta };
  return { type: "message_update", assistantMessageEvent };
}

/**
 * Identity of a codex tool item on the omp tool_execution_* wire: the display
 * `args` object (omp parity) plus `argsJson` — the RAW JSON string the model
 * produced, which is what the DSH `tool/call` payload requires. The SDK hands
 * `mcp_tool_call.arguments` over as an unparsed string, so that one rides
 * through verbatim; the other item shapes expose discrete fields (command,
 * query, changes, items), so their string is the faithful JSON rendering of
 * exactly those fields.
 */
function toolIdentity(item: Record<string, unknown>): { toolName: string; args: Record<string, unknown>; argsJson: string } {
  const json = (value: Record<string, unknown>): string => JSON.stringify(value);
  switch (item.type) {
    case "command_execution": {
      const args = { command: asText(item.command) };
      return { toolName: "command_execution", args, argsJson: json(args) };
    }
    case "mcp_tool_call": {
      const args = asRecord(item.arguments) ?? {};
      return {
        toolName: asText(item.tool) || "mcp_tool_call",
        args,
        argsJson: typeof item.arguments === "string" ? item.arguments : json(args),
      };
    }
    case "file_change": {
      const args = { changes: Array.isArray(item.changes) ? item.changes : [] };
      return { toolName: "file_change", args, argsJson: json(args) };
    }
    case "web_search": {
      const args = { query: asText(item.query) };
      return { toolName: "web_search", args, argsJson: json(args) };
    }
    case "todo_list": {
      const args = { items: Array.isArray(item.items) ? item.items : [] };
      return { toolName: "todo_list", args, argsJson: json(args) };
    }
    default:
      return { toolName: asText(item.type) || "tool", args: {}, argsJson: "{}" };
  }
}

/** Render a codex tool item's outcome as omp tool_execution_end result blocks. */
function toolResult(item: Record<string, unknown>): { content: WireContentBlock[]; isError: boolean } {
  switch (item.type) {
    case "command_execution": {
      const output = asText(item.aggregated_output);
      return { content: [{ type: "text", text: output }], isError: item.status === "failed" };
    }
    case "mcp_tool_call": {
      const result = asRecord(item.result);
      const content: WireContentBlock[] = [];
      const rawContent = result !== null && Array.isArray(result.content) ? result.content : [];
      for (const block of rawContent) {
        const record = asRecord(block);
        // Only MCP text blocks bridge (omp parity: images/unknown are dropped).
        if (record !== null && record.type === "text" && typeof record.text === "string") {
          content.push({ type: "text", text: record.text });
        }
      }
      if (content.length === 0) {
        const error = asRecord(item.error);
        if (error !== null && typeof error.message === "string") content.push({ type: "text", text: error.message });
      }
      return { content, isError: item.status === "failed" };
    }
    case "file_change": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const lines: string[] = [];
      for (const change of changes) {
        const record = asRecord(change);
        if (record !== null) lines.push(`${asText(record.kind) || "update"} ${asText(record.path)}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }], isError: item.status === "failed" };
    }
    case "web_search":
      return { content: [{ type: "text", text: asText(item.query) }], isError: false };
    case "todo_list": {
      const items = Array.isArray(item.items) ? item.items : [];
      const lines: string[] = [];
      for (const entry of items) {
        const record = asRecord(entry);
        if (record !== null) lines.push(`${record.completed === true ? "[x]" : "[ ]"} ${asText(record.text)}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }], isError: false };
    }
    default:
      return { content: [], isError: false };
  }
}

/**
 * Codex `todo_list` items → the DSH `todo/write` whole-list snapshot payload
 * (`TodoItem { content, status }`; upstream packages/todo/tool-todo). The
 * whole list is replaced on every write (latest-wins); a codex item only
 * carries the binary completed flag, so non-completed entries are `pending`.
 */
function todoSnapshot(items: unknown[]): Array<{ content: string; status: "pending" | "completed" }> {
  const todos: Array<{ content: string; status: "pending" | "completed" }> = [];
  for (const entry of items) {
    const record = asRecord(entry);
    if (record === null) continue;
    const text = asText(record.text);
    if (text === "") continue;
    todos.push({ content: text, status: record.completed === true ? "completed" : "pending" });
  }
  return todos;
}

function toolStart(item: Record<string, unknown>): WireEvent {
  const { toolName, args, argsJson } = toolIdentity(item);
  const start: WireEvent = {
    type: "tool_execution_start",
    toolCallId: asText(item.id),
    toolName,
    args,
    argumentsJson: argsJson,
  };
  if (item.type === "mcp_tool_call") start.server = asText(item.server);
  return start;
}

/**
 * Terminal tool event for a completed/updated tool item. Emits the start first
 * when this item's start was never projected (minimal chains), keeping the
 * wire's start/end pairing intact without duplicate starts.
 */
function toolEnd(item: Record<string, unknown>): WireEvent | WireEvent[] {
  const id = asText(item.id);
  const { toolName } = toolIdentity(item);
  const result = toolResult(item);
  const end: WireEvent = { type: "tool_execution_end", toolCallId: id, toolName, result, isError: result.isError };
  if (item.type === "command_execution") {
    end.command = asText(item.command);
    if (typeof item.exit_code === "number") end.exit_code = item.exit_code;
  }
  if (!startedTools.has(id)) {
    // start never fired for this id (fixture-style minimal chain): emit the pair.
    startedTools.add(id);
    return [toolStart(item), end];
  }
  return end;
}

function projectItem(item: unknown, phase: "started" | "updated" | "completed"): WireEvent | WireEvent[] | null {
  const record = asRecord(item);
  if (record === null) return null;
  const id = asText(record.id);
  switch (record.type) {
    case "agent_message": {
      const text = asText(record.text);
      if (phase === "started") {
        textWatermark.set(id, text);
        const start: WireEvent = { type: "message_start", message: { role: "assistant", content: [] } };
        return text === "" ? start : [start, textDelta(text)];
      }
      if (phase === "updated") {
        const previous = textWatermark.get(id) ?? "";
        if (text === previous) return null;
        const delta = text.startsWith(previous) ? text.slice(previous.length) : text;
        textWatermark.set(id, text);
        return textDelta(delta);
      }
      textWatermark.delete(id);
      return {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text }] },
      };
    }
    case "reasoning": {
      const text = asText(record.text);
      if (phase === "started") {
        return {
          type: "message_start",
          message: { role: "assistant", content: [{ type: "thinking", thinking: text }] },
        };
      }
      if (phase === "updated") {
        // Deltas fold into the final thinking block (omp folds thinking_* too).
        return null;
      }
      return {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "thinking", thinking: text }] },
      };
    }
    case "command_execution":
    case "mcp_tool_call":
    case "file_change":
    case "web_search":
    case "todo_list": {
      if (phase === "started") {
        startedTools.add(id);
        return toolStart(record);
      }
      const terminal = record.status === "completed" || record.status === "failed";
      if (phase === "updated") {
        return terminal ? toolEnd(record) : null; // still in_progress → nothing new
      }
      const events = toolEnd(record); // completed is terminal by definition (toolEnd dedups the start)
      if (record.type !== "todo_list") return events;
      // `item.todo_list` ALSO projects the DSH `todo/write` whole-list snapshot
      // (log-only, latest-wins) after the tool pair — the tool pair stays.
      const todos = todoSnapshot(Array.isArray(record.items) ? record.items : []);
      return [...(Array.isArray(events) ? events : [events]), { type: "todo_write", todos }];
    }
    case "error": {
      if (phase === "completed") {
        // Non-fatal item-level error: ride omp's stopReason "error" assistant
        // message shape so agent.ts's ompFailure() classifies it downstream.
        return {
          type: "message_end",
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: asText(record.message),
          },
        };
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Project one codex SDK ThreadEvent (duck-typed, never imported into dist)
 * onto the omp wire vocabulary. Returns one event, an ordered array, or null
 * for ignorable/malformed input. Never throws.
 */
export function projectThreadEvent(evt: unknown): WireEvent | WireEvent[] | null {
  try {
    const record = asRecord(evt);
    if (record === null || typeof record.type !== "string") return null;
    switch (record.type) {
      case "thread.started": {
        const start: WireEvent = { type: "agent_start" };
        if (typeof record.thread_id === "string" && record.thread_id !== "") {
          start.data = { threadId: record.thread_id };
        }
        return start;
      }
      case "turn.started":
        return { type: "turn_start" };
      case "item.started":
        return projectItem(record.item, "started");
      case "item.updated":
        return projectItem(record.item, "updated");
      case "item.completed":
        return projectItem(record.item, "completed");
      case "turn.completed": {
        const usage = asRecord(record.usage);
        return usage === null ? { type: "turn_end" } : { type: "turn_end", data: { usage } };
      }
      case "turn.failed": {
        const error = asRecord(record.error);
        return error === null ? { type: "turn_end" } : { type: "turn_end", data: { error } };
      }
      case "error":
        // Fatal stream error: the client reports it via onFailure; the wire
        // stream stays silent (S5 ignorable-event invariant).
        return null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}
