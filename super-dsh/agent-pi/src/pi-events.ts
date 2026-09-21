/**
 * pi-events — pure projection from pi's `AgentSessionEvent` stream onto the
 * wire vocabulary the omp/codex bridges share (agent_start / turn_start /
 * message_* / tool_execution_* / turn_end / agent_end), plus pi-specific
 * events nothing upstream has: `session_title` (pi owns titles) and the
 * `compaction_start|end` pair (pi compaction is real and wired here).
 *
 * Duck-typed on pi's event shapes (verified against @earendil-works/
 * pi-agent-core dist 0.84.2): the projection never imports the SDK, so tests
 * run without touching pi and future pi point releases fail loudly HERE
 * instead of silently changing the DSH log. Unknown, unmapped, and non-object
 * events project to `null` — never throw into the SDK's subscribe loop.
 */
import { JSONStringifySafe } from "./safe-json.js";

/** Wire content block vocabulary (the omp bridge's shapes, verbatim). */
export type WireContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: string };

/** Wire message shape (subset the agent bridge consumes). */
export interface WireMessage {
  role: string;
  content: WireContentBlock[];
  provider?: string;
  model?: string;
  /** pi `Usage` record (camelCase): input/output/cacheRead/cacheWrite/reasoning. */
  usage?: Record<string, unknown>;
  stopReason?: string;
  errorMessage?: string;
  errorStatus?: number;
  toolCallId?: string;
  isError?: boolean;
}

/** The `message_update` delta payload (pi assistantMessageEvent, duck-typed). */
export type WireAssistantMessageEvent = { type: string; delta?: string; contentIndex?: number } & Record<string, unknown>;

/** The wire event union the PiAgent switch consumes. */
export type WireEvent =
  | { type: "agent_start" }
  | { type: "agent_end" }
  | { type: "turn_start" }
  | { type: "turn_end" }
  | { type: "message_start"; message: WireMessage }
  | { type: "message_end"; message: WireMessage }
  | { type: "message_update"; assistantMessageEvent: Record<string, unknown> }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: { content?: WireContentBlock[] }; isError: boolean }
  | { type: "session_title"; name: string | undefined }
  | { type: "compaction_start"; reason: string }
  | { type: "compaction_end"; aborted: boolean };

// Events pi emits that this adapter deliberately does not project (V1):
// agent_settled (idle bookkeeping), queue_update (client-internal queue),
// entry_appended (the log is DSH's), thinking_level_changed, auto_retry_* /
// summarization_retry_* (folded into the turn's outcome), bash_execution_update.

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function convertContent(blocks: unknown): WireContentBlock[] {
  if (!Array.isArray(blocks)) return [];
  const out: WireContentBlock[] = [];
  for (const raw of blocks) {
    const block = asRecord(raw);
    if (block === null) continue;
    switch (block["type"]) {
      case "text":
        if (typeof block["text"] === "string") out.push({ type: "text", text: block["text"] });
        break;
      case "thinking":
        if (typeof block["thinking"] === "string") out.push({ type: "thinking", thinking: block["thinking"] });
        break;
      case "toolCall": {
        // The DSH `tool/call` payload wants the RAW JSON string the model
        // produced; pi parses it into an object, so re-stringify here.
        const args = block["arguments"];
        out.push({
          type: "toolCall",
          id: optionalString(block["id"]) ?? "",
          name: optionalString(block["name"]) ?? "",
          arguments: typeof args === "string" ? args : JSONStringifySafe(args ?? {}),
        });
        break;
      }
      default:
        // images / unknown blocks are not bridged in V1.
        break;
    }
  }
  return out;
}

function convertMessage(raw: unknown): WireMessage {
  const message = asRecord(raw);
  if (message === null) return { role: "unknown", content: [] };
  const wire: WireMessage = {
    role: optionalString(message["role"]) ?? "unknown",
    content: convertContent(message["content"]),
  };
  const provider = optionalString(message["provider"]);
  const model = optionalString(message["model"]);
  if (provider !== undefined) wire.provider = provider;
  if (model !== undefined) wire.model = model;
  const usage = asRecord(message["usage"]);
  if (usage !== null) wire.usage = usage;
  const stopReason = optionalString(message["stopReason"]);
  if (stopReason !== undefined) wire.stopReason = stopReason;
  const errorMessage = optionalString(message["errorMessage"]);
  if (errorMessage !== undefined) wire.errorMessage = errorMessage;
  if (typeof message["errorStatus"] === "number") wire.errorStatus = message["errorStatus"];
  const toolCallId = optionalString(message["toolCallId"]);
  if (toolCallId !== undefined) wire.toolCallId = toolCallId;
  if (typeof message["isError"] === "boolean") wire.isError = message["isError"];
  return wire;
}

/**
 * Project one raw pi event. Returns the wire event, `null` for anything this
 * adapter does not project. Pure and total: no imports from the SDK, no I/O,
 * no throws.
 */
export function projectSessionEvent(raw: unknown): WireEvent | null {
  const event = asRecord(raw);
  if (event === null) return null;
  switch (event["type"]) {
    case "agent_start":
      return { type: "agent_start" };
    case "agent_end":
      return { type: "agent_end" };
    case "turn_start":
      return { type: "turn_start" };
    case "turn_end":
      return { type: "turn_end" };
    case "message_start":
      return { type: "message_start", message: convertMessage(event["message"]) };
    case "message_end":
      return { type: "message_end", message: convertMessage(event["message"]) };
    case "message_update": {
      const delta = asRecord(event["assistantMessageEvent"]);
      if (delta === null) return null;
      return { type: "message_update", assistantMessageEvent: delta };
    }
    case "tool_execution_start": {
      const toolCallId = optionalString(event["toolCallId"]);
      if (toolCallId === undefined) return null;
      return {
        type: "tool_execution_start",
        toolCallId,
        toolName: optionalString(event["toolName"]) ?? "",
        args: event["args"],
      };
    }
    case "tool_execution_end": {
      const toolCallId = optionalString(event["toolCallId"]);
      if (toolCallId === undefined) return null;
      return {
        type: "tool_execution_end",
        toolCallId,
        toolName: optionalString(event["toolName"]) ?? "",
        result: asRecord(event["result"]) as { content?: WireContentBlock[] } | null ?? {},
        isError: event["isError"] === true,
      };
    }
    case "session_info_changed":
      return { type: "session_title", name: optionalString(event["name"]) };
    case "compaction_start":
      return { type: "compaction_start", reason: optionalString(event["reason"]) ?? "manual" };
    case "compaction_end":
      return { type: "compaction_end", aborted: event["aborted"] === true };
    default:
      return null;
  }
}
