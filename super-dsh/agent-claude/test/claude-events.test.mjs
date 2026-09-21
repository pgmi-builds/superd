import { test } from "node:test";
import assert from "node:assert/strict";

const { projectClaudeEvent, resetProjectionState } = await import("../dist/claude-events.js");

test("system/init becomes one session_init wire event carrying the runtime metadata", () => {
  resetProjectionState();
  const out = projectClaudeEvent({
    type: "system", subtype: "init", session_id: "s-1", cwd: "/w", model: "opus",
    permissionMode: "default", tools: ["Bash"], slash_commands: ["/mcp"], skills: [], plugins: [],
    mcp_servers: [], claude_code_version: "2.1.261", apiKeySource: "none", output_style: "default",
  });
  assert.equal(out.type, "session_init");
  assert.equal(out.sessionId, "s-1");
  assert.equal(out.model, "opus");
  assert.deepEqual(out.slashCommands, ["/mcp"]);
});

test("an assistant message yields reasoning + text + tool_start, never a thinking block", () => {
  resetProjectionState();
  const out = projectClaudeEvent({
    type: "assistant", session_id: "s-1", parent_tool_use_id: null, uuid: "u1",
    message: {
      role: "assistant", content: [
        { type: "reasoning", text: "why" },
        { type: "text", text: "hello" },
        { type: "tool_use", id: "c1", name: "Bash", input: { command: "ls" } },
      ]
    },
  });
  const types = out.map((e) => e.type);
  assert.deepEqual(types, ["assistant_reasoning", "assistant_text", "tool_start"]);
  assert.equal(out[0].text, "why");
  assert.equal(out[2].callId, "c1");
  assert.equal(out[2].name, "bash", "normalized per 2026-09-18 ruling");
  assert.deepEqual(out[2].arguments, { command: "ls" });
});

test("a user message carrying tool_use_result becomes tool_end, nested via parent_tool_use_id", () => {
  resetProjectionState();
  const out = projectClaudeEvent({
    type: "user", session_id: "s-1", parent_tool_use_id: "agent-7", uuid: "u2",
    tool_use_result: { content: [{ type: "text", text: "ok" }], is_error: false },
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "ok" }] },
  });
  assert.equal(out.type, "tool_end");
  assert.equal(out.callId, "c1");
  assert.equal(out.isError, false);
  assert.equal(out.parentToolUseId, "agent-7");
});

test("result becomes turn_end with usage; refusal/compaction/permission_denied map to their own types", () => {
  resetProjectionState();
  assert.equal(projectClaudeEvent({
    type: "result", subtype: "success", session_id: "s-1", is_error: false, num_turns: 1,
    duration_ms: 5, duration_api_ms: 4, total_cost_usd: 0.01,
    usage: { input_tokens: 3, output_tokens: 4 }, modelUsage: {}, permission_denials: [], result: "done",
  }).type, "turn_end");

  assert.equal(projectClaudeEvent({
    type: "system", subtype: "compact_boundary", session_id: "s-1", uuid: "u3",
    compact_metadata: { trigger: "auto", pre_tokens: 10, post_tokens: 3 },
  }).type, "compaction");

  assert.equal(projectClaudeEvent({
    type: "system", subtype: "permission_denied", session_id: "s-1", tool_name: "Bash", tool_use_id: "c2",
  }).type, "permission_denied");

  assert.equal(projectClaudeEvent({
    type: "system", subtype: "model_refusal_fallback", session_id: "s-1", uuid: "u4",
    trigger: "refusal", direction: "retry", original_model: "a", fallback_model: "b",
    retracted_message_uuids: ["u1"], refused_user_message_uuid: "u0", content: "fell back",
  }).type, "refusal_fallback");

  assert.equal(projectClaudeEvent({ type: "stream_event", session_id: "s-1", uuid: "u5", event: { type: "x" } }), null);
  assert.equal(projectClaudeEvent({ type: "unknown_future_type" }), null);
});

// --- RC-2 / RC-6 typed-upgrade pins -----------------------------------------

test("a thinking block folds into reasoning alongside the reasoning block shape", () => {
  resetProjectionState();
  const out = projectClaudeEvent({
    type: "assistant", session_id: "s-1", parent_tool_use_id: null, uuid: "u1",
    message: { role: "assistant", content: [
      { type: "thinking", thinking: "ponder" },
      { type: "reasoning", text: " more" },
    ] },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "assistant_reasoning");
  assert.equal(out[0].text, "ponder more");
});

test("per-message usage and model ride every event projected from an assistant message", () => {
  resetProjectionState();
  const out = projectClaudeEvent({
    type: "assistant", session_id: "s-1", parent_tool_use_id: null, uuid: "u1",
    message: {
      role: "assistant", model: "sonnet",
      usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 11, cache_creation_input_tokens: null },
      content: [
        { type: "text", text: "hi" },
        { type: "tool_use", id: "c9", name: "Read", input: { path: "/x" } },
      ],
    },
  });
  assert.deepEqual(out.map((event) => event.type), ["assistant_text", "tool_start"]);
  for (const event of out) {
    assert.deepEqual(event.usage, { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 11, cache_creation_input_tokens: null });
    assert.equal(event.model, "sonnet");
  }
  // No usage on the wire → no provenance keys at all.
  const bare = projectClaudeEvent({
    type: "assistant", session_id: "s-1", parent_tool_use_id: null, uuid: "u2",
    message: { role: "assistant", content: [{ type: "text", text: "plain" }] },
  });
  assert.equal("usage" in bare[0], false);
  assert.equal("model" in bare[0], false);
});

test("TodoWrite keeps its tool_start AND adds the whole-list todo/write snapshot", () => {
  resetProjectionState();
  const out = projectClaudeEvent({
    type: "assistant", session_id: "s-1", parent_tool_use_id: null, uuid: "u1",
    message: { role: "assistant", content: [{
      type: "tool_use", id: "t1", name: "TodoWrite",
      input: { todos: [
        { content: "read plan", status: "completed" },
        { content: "edit adapter", status: "in_progress", activeForm: "editing" },
        { content: "", status: "pending" },
        { content: "junk status", status: "banana" },
        "not-an-object",
      ] },
    }] },
  });
  assert.deepEqual(out.map((event) => event.type), ["tool_start", "todo_write"], "the tool pair stays; todo/write rides after it");
  assert.equal(out[0].name, "TodoWrite");
  assert.deepEqual(out[1].todos, [
    { content: "read plan", status: "completed" },
    { content: "edit adapter", status: "in_progress" },
    { content: "junk status", status: "pending" },
  ]);
});

test("a TodoWrite call without a todos array emits no todo/write snapshot", () => {
  resetProjectionState();
  const out = projectClaudeEvent({
    type: "assistant", session_id: "s-1", parent_tool_use_id: null, uuid: "u1",
    message: { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "TodoWrite", input: { todos: "nope" } }] },
  });
  assert.deepEqual(out.map((event) => event.type), ["tool_start"]);
});

test("a whole-list todo snapshot of [] survives (an emptied list is a legitimate write)", () => {
  resetProjectionState();
  const out = projectClaudeEvent({
    type: "assistant", session_id: "s-1", parent_tool_use_id: null, uuid: "u1",
    message: { role: "assistant", content: [{ type: "tool_use", id: "t3", name: "TodoWrite", input: { todos: [] } }] },
  });
  assert.deepEqual(out.map((event) => event.type), ["tool_start", "todo_write"]);
  assert.deepEqual(out[1].todos, []);
});

// ---- tool-name normalization + failure classification (2026-09-18) ----

test("normalizeToolName maps SDK names onto the dsh vocabulary; unknowns pass verbatim", async () => {
  const { normalizeToolName } = await import("../dist/claude-events.js");
  assert.equal(normalizeToolName("Bash"), "bash");
  assert.equal(normalizeToolName("Read"), "read");
  assert.equal(normalizeToolName("Write"), "write");
  assert.equal(normalizeToolName("Edit"), "edit");
  assert.equal(normalizeToolName("Grep"), "grep");
  assert.equal(normalizeToolName("Glob"), "glob");
  assert.equal(normalizeToolName("MultiEdit"), "edit");
  // No native twin → honest verbatim pass-through.
  assert.equal(normalizeToolName("Task"), "Task");
  assert.equal(normalizeToolName("WebSearch"), "WebSearch");
  assert.equal(normalizeToolName("TodoWrite"), "TodoWrite");
  assert.equal(normalizeToolName("AskUserQuestion"), "AskUserQuestion");
});

test("tool_use projection emits the normalized name and tool_end recalls it", async () => {
  const { projectClaudeEvent, resetProjectionState } = await import("../dist/claude-events.js");
  resetProjectionState();
  const start = projectClaudeEvent({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] },
  });
  const startEvent = Array.isArray(start) ? start.find((e) => e.type === "tool_start") : start;
  assert.equal(startEvent.name, "bash", "tool_start carries the normalized name");

  const end = projectClaudeEvent({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
  });
  const endEvent = Array.isArray(end) ? end.find((e) => e.type === "tool_end") : end;
  assert.equal(endEvent.name, "bash", "tool_end recalls the normalized name");
});

test("classifyClaudeError: conversation-not-found is terminal; the rest stays UNKNOWN", async () => {
  const { classifyClaudeError } = await import("../dist/agent.js");
  assert.equal(classifyClaudeError(new Error("Claude Code returned an error result: No conversation found with session ID: 5745d3be")), "CONVERSATION_NOT_FOUND");
  assert.equal(classifyClaudeError(new Error("boom")), "UNKNOWN");
  assert.equal(classifyClaudeError("string error"), "UNKNOWN");
});

test("session map: resumable is sticky, round-trips, and an explicit true clears it", async () => {
  const { upsertSession, sessionRecord } = await import("../dist/session-map.js");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "aw-claude-map-"));
  try {
    upsertSession(home, "session-a", { claudeSessionId: "a", cwd: "/w", createdAt: 1 });
    assert.equal(sessionRecord(home, "session-a").resumable, undefined, "absent = resumable");
    upsertSession(home, "session-a", { resumable: false });
    assert.equal(sessionRecord(home, "session-a").resumable, false, "false round-trips through disk");
    upsertSession(home, "session-a", { claudeMode: "default" });
    assert.equal(sessionRecord(home, "session-a").resumable, false, "sticky across unrelated upserts");
    upsertSession(home, "session-a", { resumable: true });
    assert.equal(sessionRecord(home, "session-a").resumable, undefined, "explicit true clears");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
