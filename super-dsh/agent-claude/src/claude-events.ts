/**
 * Claude Agent SDK message -> neutral wire event projection.
 *
 * Only the message shapes the adapter consumes are translated; every other
 * SDKMessage variant returns null (ignored, not an error). Tool results pair by
 * `tool_use_id`; `parent_tool_use_id` marks subagent-nested traffic.
 *
 * Per-message token accounting (`message.usage`) and the message's model ride
 * every event projected from that assistant message (RC-6): the agent closes
 * the step's usage attempt with the sample of the message that opened it, so a
 * mid-turn `tool_start` flush still lands a same-attempt sample.
 *
 * `TodoWrite` tool calls ALSO project a `todo_write` whole-list snapshot
 * (upstream packages/todo/tool-todo vocabulary, latest-wins) while keeping the
 * tool/call + tool/result pair.
 *
 * Tool NAME normalization (2026-09-18 user ruling): the dsh WebUI keys its
 * typed tool presentation on the native dsh tool-name vocabulary (lowercase:
 * read/write/edit/bash/grep/glob — verified against ctx0's own durable logs).
 * The Claude SDK reports PascalCase names, which fall through to the generic
 * "Tool call" chip. The known table below maps SDK names onto the native
 * vocabulary; anything unknown passes through VERBATIM (honest best-effort —
 * never invented names).
 *
 * NOTE (spec §6.5): refusal fallback is wired from these two system messages,
 * NOT from a dialog — the adapter declares no dialog kinds in V1.
 */
export interface WireEvent { type: string;[k: string]: unknown }

let toolNames = new Map<string, string>();

export function resetProjectionState(): void {
  toolNames = new Map();
}

/**
 * SDK tool name → native dsh tool name (2026-09-18). Keys are the Claude
 * Agent SDK's built-in tool names; values are the dsh vocabulary the WebUI's
 * typed presenters recognize. Unknown names pass through untouched.
 */
const TOOL_NAME_ALIASES: Readonly<Record<string, string>> = {
  Bash: "bash",
  Read: "read",
  Write: "write",
  Edit: "edit",
  Grep: "grep",
  Glob: "glob",
  MultiEdit: "edit",
  NotebookEdit: "edit",
};

/** Normalize one SDK tool name onto the dsh vocabulary (verbatim when unknown). */
export function normalizeToolName(name: string): string {
  return TOOL_NAME_ALIASES[name] ?? name;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function textOf(content: unknown): { text: string; reasoning: string; tool: Record<string, unknown>[] } {
  const result = { text: "", reasoning: "", tool: [] as Record<string, unknown>[] };
  if (!Array.isArray(content)) return result;
  for (const raw of content) {
    const block = asRecord(raw);
    if (block === null) continue;
    if (block.type === "text" && typeof block.text === "string") result.text += block.text;
    // Reasoning reaches the wire in two shapes: the Beta API `reasoning`
    // block (`{type, text}`) and the CLI's `thinking` block (`{type,
    // thinking}`). Both fold into the same reasoning text.
    if (block.type === "reasoning" && typeof block.text === "string") result.reasoning += block.text;
    if (block.type === "thinking" && typeof block.thinking === "string") result.reasoning += block.thinking;
    if (block.type === "tool_use") result.tool.push(block);
  }
  return result;
}

/**
 * Claude `TodoWrite` input → the DSH `todo/write` whole-list snapshot payload
 * (`TodoItem { content, status }`; upstream packages/todo/tool-todo). The
 * whole list is replaced on every write (latest-wins). Defensive: rows with
 * no usable content text are dropped, and an unknown status degrades to
 * `pending`. Returns undefined when the input carries no todos array at all
 * (not a todo write), so a malformed call never clears the list.
 */
function todoSnapshot(input: unknown): Array<{ content: string; status: "pending" | "in_progress" | "completed" }> | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const items = (input as Record<string, unknown>).todos;
  if (!Array.isArray(items)) return undefined;
  const todos: Array<{ content: string; status: "pending" | "in_progress" | "completed" }> = [];
  for (const entry of items) {
    const record = asRecord(entry);
    if (record === null) continue;
    const content = typeof record.content === "string" ? record.content : "";
    if (content === "") continue;
    const status = record.status === "completed" || record.status === "in_progress" ? record.status : "pending";
    todos.push({ content, status });
  }
  return todos;
}

export function projectClaudeEvent(message: unknown): WireEvent | WireEvent[] | null {
  const msg = asRecord(message);
  if (msg === null || typeof msg.type !== "string") return null;

  if (msg.type === "system") {
    switch (msg.subtype) {
      case "init":
        return {
          type: "session_init",
          sessionId: msg.session_id,
          cwd: msg.cwd,
          model: msg.model,
          permissionMode: msg.permissionMode,
          tools: msg.tools,
          slashCommands: msg.slash_commands,
          skills: msg.skills,
          plugins: msg.plugins,
          mcpServers: msg.mcp_servers,
          cliVersion: msg.claude_code_version,
          apiKeySource: msg.apiKeySource,
        };
      case "compact_boundary":
        return { type: "compaction", metadata: msg.compact_metadata };
      case "permission_denied":
        return {
          type: "permission_denied",
          toolName: msg.tool_name,
          callId: msg.tool_use_id,
          reasonType: msg.decision_reason_type,
        };
      case "model_refusal_fallback":
        return {
          type: "refusal_fallback",
          direction: msg.direction,
          scope: msg.scope ?? "session",
          originalModel: msg.original_model,
          fallbackModel: msg.fallback_model,
          category: msg.api_refusal_category ?? null,
          explanation: msg.api_refusal_explanation ?? null,
          retractedMessageUuids: msg.retracted_message_uuids ?? [],
          refusedUserMessageUuid: msg.refused_user_message_uuid ?? null,
          content: msg.content,
        };
      case "model_refusal_no_fallback":
        return {
          type: "refusal_no_fallback",
          originalModel: msg.original_model,
          category: msg.api_refusal_category ?? null,
          explanation: msg.api_refusal_explanation ?? null,
          refusedUserMessageUuid: msg.refused_user_message_uuid ?? null,
          content: msg.content,
        };
      case "local_command_output":
        return { type: "local_command_output", content: msg.content };
      default:
        return null;
    }
  }

  if (msg.type === "assistant") {
    const body = asRecord(msg.message);
    const parsed = textOf(body?.content);
    const out: WireEvent[] = [];
    // Per-message accounting rides every event projected from THIS message
    // (RC-6): the agent closes the step's attempt with the usage of the
    // message that opened it, so a tool_start flush still lands a sample.
    const usage = asRecord(body?.usage);
    const model = typeof body?.model === "string" && body.model !== "" ? body.model : undefined;
    const provenance = {
      ...(usage === null ? {} : { usage }),
      ...(model === undefined ? {} : { model }),
    };
    if (parsed.reasoning !== "") out.push({ type: "assistant_reasoning", text: parsed.reasoning, parentToolUseId: msg.parent_tool_use_id ?? null, ...provenance });
    if (parsed.text !== "") out.push({ type: "assistant_text", text: parsed.text, parentToolUseId: msg.parent_tool_use_id ?? null, ...provenance });
    for (const block of parsed.tool) {
      const id = String(block.id ?? "");
      const name = normalizeToolName(String(block.name ?? "tool"));
      if (id !== "") toolNames.set(id, name);
      out.push({
        type: "tool_start",
        callId: id,
        name,
        arguments: block.input ?? {},
        parentToolUseId: msg.parent_tool_use_id ?? null,
        ...provenance,
      });
      // `TodoWrite` ALSO projects the DSH `todo/write` whole-list snapshot
      // (log-only, latest-wins) after the tool_start — the tool pair stays.
      if (String(block.name ?? "") === "TodoWrite") {
        const todos = todoSnapshot(block.input ?? null);
        if (todos !== undefined) out.push({ type: "todo_write", todos });
      }
    }
    if (out.length === 0) out.push({ type: "assistant_message", raw: body ?? null });
    return out;
  }

  if (msg.type === "user") {
    const body = asRecord(msg.message);
    const content = Array.isArray(body?.content) ? body.content : [];
    const out: WireEvent[] = [];
    for (const raw of content) {
      const block = asRecord(raw);
      if (block?.type !== "tool_result") continue;
      const callId = String(block.tool_use_id ?? "");
      const text = typeof block.content === "string"
        ? block.content
        : Array.isArray(block.content)
          ? block.content.map((part) => String(asRecord(part)?.text ?? "")).join("")
          : "";
      out.push({
        type: "tool_end",
        callId,
        name: toolNames.get(callId) ?? "tool",
        content: text,
        isError: block.is_error === true,
        parentToolUseId: msg.parent_tool_use_id ?? null,
      });
    }
    // One result is the common shape and stays a bare event; only a parallel
    // tool_result batch needs the array form (mirrors codex-events' toolEnd).
    return out.length === 0 ? null : out.length === 1 ? out[0] : out;
  }

  if (msg.type === "result") {
    return {
      type: "turn_end",
      subtype: msg.subtype,
      isError: msg.is_error === true,
      numTurns: msg.num_turns,
      durationMs: msg.duration_ms,
      durationApiMs: msg.duration_api_ms,
      costUsd: msg.total_cost_usd,
      usage: msg.usage,
      modelUsage: msg.modelUsage,
      permissionDenials: msg.permission_denials,
      result: msg.result,
      errors: msg.errors,
      stopReason: msg.stop_reason ?? null,
    };
  }

  return null;
}
