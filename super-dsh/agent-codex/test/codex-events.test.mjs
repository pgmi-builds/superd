// Task 2 TDD (RED first): Codex SDK ThreadEvent → omp wire vocabulary projection.
// Fixture input = the Task 1 captured chain; hand-built chains cover streaming
// deltas, tool items, failure payloads, and malformed/unknown inputs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { projectThreadEvent, resetProjectionState } from "../dist/codex-events.js";

const FIXTURE = JSON.parse(
  readFileSync(join(new URL(".", import.meta.url).pathname, "fixtures", "thread-events.sample.json"), "utf8"),
);

test("fixture: full captured chain projects onto the omp wire vocabulary", () => {
  resetProjectionState();
  const projected = FIXTURE.events.map(projectThreadEvent);
  const [agentStart, turnStart, reasoningEnd, messageEnd, turnEnd] = projected;

  // thread.started → agent_start, threadId attached in data
  assert.deepEqual(agentStart, { type: "agent_start", data: { threadId: FIXTURE.threadId } });
  // turn.started → turn_start
  assert.deepEqual(turnStart, { type: "turn_start" });
  // item.completed reasoning → assistant message carrying a thinking block
  assert.equal(reasoningEnd.type, "message_end");
  assert.equal(reasoningEnd.message.role, "assistant");
  assert.deepEqual(reasoningEnd.message.content, [
    { type: "thinking", thinking: "User asks exact output ok. Need final exactly." },
  ]);
  // item.completed agent_message → message_end with the full text block
  assert.equal(messageEnd.type, "message_end");
  assert.equal(messageEnd.message.role, "assistant");
  assert.deepEqual(messageEnd.message.content, [{ type: "text", text: "ok" }]);
  // turn.completed → turn_end with the raw codex usage verbatim
  assert.deepEqual(turnEnd, { type: "turn_end", data: { usage: FIXTURE.events[4].usage } });
});

test("streaming chain: started/updated delta growth accumulates into text_delta", () => {
  resetProjectionState();
  const chain = [
    { type: "thread.started", thread_id: "t-1" },
    { type: "turn.started" },
    { type: "item.started", item: { id: "i1", type: "agent_message", text: "" } },
    { type: "item.updated", item: { id: "i1", type: "agent_message", text: "Hel" } },
    { type: "item.updated", item: { id: "i1", type: "agent_message", text: "Hello" } },
    { type: "item.completed", item: { id: "i1", type: "agent_message", text: "Hello!" } },
  ];
  const projected = chain.map(projectThreadEvent);
  assert.deepEqual(projected[0], { type: "agent_start", data: { threadId: "t-1" } });
  assert.deepEqual(projected[1], { type: "turn_start" });
  // empty start → bare message_start
  assert.deepEqual(projected[2], { type: "message_start", message: { role: "assistant", content: [] } });
  // growth since the last watermark → delta "Hel"
  assert.deepEqual(projected[3], {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" },
  });
  // growth "Hello" - "Hel" → delta "lo"
  assert.deepEqual(projected[4], {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" },
  });
  // completed carries the FULL final text regardless of the watermark
  assert.deepEqual(projected[5], {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "Hello!" }] },
  });
});

test("reasoning item projects as thinking-carrying messages", () => {
  resetProjectionState();
  const started = projectThreadEvent({ type: "item.started", item: { id: "r1", type: "reasoning", text: "" } });
  assert.deepEqual(started, {
    type: "message_start",
    message: { role: "assistant", content: [{ type: "thinking", thinking: "" }] },
  });
  // reasoning updates are folded into the final block (omp folds thinking_*)
  const updated = projectThreadEvent({ type: "item.updated", item: { id: "r1", type: "reasoning", text: "hmm" } });
  assert.equal(updated, null);
  const completed = projectThreadEvent({
    type: "item.completed",
    item: { id: "r1", type: "reasoning", text: "Let me think." },
  });
  assert.deepEqual(completed, {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "thinking", thinking: "Let me think." }] },
  });
});

test("command_execution: started→tool_execution_start, completed→start+end pair (start deduped)", () => {
  resetProjectionState();
  const started = projectThreadEvent({
    type: "item.started",
    item: { id: "c1", type: "command_execution", command: "npm test", aggregated_output: "", status: "in_progress" },
  });
  assert.deepEqual(started, {
    type: "tool_execution_start",
    toolCallId: "c1",
    toolName: "command_execution",
    args: { command: "npm test" },
    argumentsJson: JSON.stringify({ command: "npm test" }),
  });
  // still in_progress on update → nothing new
  const updated = projectThreadEvent({
    type: "item.updated",
    item: { id: "c1", type: "command_execution", command: "npm test", aggregated_output: "...", status: "in_progress" },
  });
  assert.equal(updated, null);
  // terminal → tool_execution_end only (start already emitted for this id)
  const completed = projectThreadEvent({
    type: "item.completed",
    item: {
      id: "c1",
      type: "command_execution",
      command: "npm test",
      aggregated_output: "15 pass",
      exit_code: 0,
      status: "completed",
    },
  });
  assert.deepEqual(completed, {
    type: "tool_execution_end",
    toolCallId: "c1",
    toolName: "command_execution",
    command: "npm test",
    exit_code: 0,
    result: { content: [{ type: "text", text: "15 pass" }], isError: false },
    isError: false,
  });
});

test("command_execution completed WITHOUT a prior started emits the full start+end pair", () => {
  resetProjectionState();
  const pair = projectThreadEvent({
    type: "item.completed",
    item: {
      id: "c2",
      type: "command_execution",
      command: "ls -la",
      aggregated_output: "total 0",
      exit_code: 1,
      status: "failed",
    },
  });
  assert.deepEqual(pair, [
    { type: "tool_execution_start", toolCallId: "c2", toolName: "command_execution", args: { command: "ls -la" }, argumentsJson: JSON.stringify({ command: "ls -la" }) },
    {
      type: "tool_execution_end",
      toolCallId: "c2",
      toolName: "command_execution",
      command: "ls -la",
      exit_code: 1,
      result: { content: [{ type: "text", text: "total 0" }], isError: true },
      isError: true,
    },
  ]);
});

test("mcp_tool_call completed maps onto the tool execution pair", () => {
  resetProjectionState();
  const pair = projectThreadEvent({
    type: "item.completed",
    item: {
      id: "m1",
      type: "mcp_tool_call",
      server: "graphify",
      tool: "get_node",
      arguments: { label: "main" },
      result: { content: [{ type: "text", text: "node found" }], structured_content: {}, _meta: {} },
      status: "completed",
    },
  });
  assert.deepEqual(pair, [
    {
      type: "tool_execution_start",
      toolCallId: "m1",
      toolName: "get_node",
      server: "graphify",
      args: { label: "main" },
      argumentsJson: JSON.stringify({ label: "main" }),
    },
    {
      type: "tool_execution_end",
      toolCallId: "m1",
      toolName: "get_node",
      result: { content: [{ type: "text", text: "node found" }], isError: false },
      isError: false,
    },
  ]);
  // failed call with only an error payload
  resetProjectionState();
  const failed = projectThreadEvent({
    type: "item.completed",
    item: {
      id: "m2",
      type: "mcp_tool_call",
      server: "s",
      tool: "t",
      arguments: {},
      error: { message: "tool exploded" },
      status: "failed",
    },
  });
  assert.equal(failed[1].isError, true);
  assert.deepEqual(failed[1].result.content, [{ type: "text", text: "tool exploded" }]);
});

test("file_change / web_search / todo_list map onto the closest tool shapes (fail-soft)", () => {
  resetProjectionState();
  const fileChange = projectThreadEvent({
    type: "item.completed",
    item: {
      id: "f1",
      type: "file_change",
      changes: [
        { path: "src/a.ts", kind: "update" },
        { path: "src/b.ts", kind: "add" },
      ],
      status: "completed",
    },
  });
  assert.equal(fileChange[0].type, "tool_execution_start");
  assert.equal(fileChange[0].toolName, "file_change");
  assert.deepEqual(fileChange[0].args, {
    changes: [
      { path: "src/a.ts", kind: "update" },
      { path: "src/b.ts", kind: "add" },
    ],
  });
  assert.deepEqual(fileChange[1].result.content, [{ type: "text", text: "update src/a.ts\nadd src/b.ts" }]);
  assert.equal(fileChange[1].isError, false);

  resetProjectionState();
  const search = projectThreadEvent({
    type: "item.completed",
    item: { id: "w1", type: "web_search", query: "codex sdk events" },
  });
  assert.equal(search[0].toolName, "web_search");
  assert.deepEqual(search[0].args, { query: "codex sdk events" });
  assert.equal(search[1].isError, false);

  resetProjectionState();
  const todos = projectThreadEvent({
    type: "item.completed",
    item: {
      id: "t9",
      type: "todo_list",
      items: [
        { text: "one", completed: true },
        { text: "two", completed: false },
      ],
    },
  });
  assert.equal(todos[0].toolName, "todo_list");
  assert.deepEqual(todos[1].result.content, [{ type: "text", text: "[x] one\n[ ] two" }]);
  // X1: the todo_list item ALSO projects the DSH `todo/write` whole-list
  // snapshot (log-only, latest-wins) after the intact tool pair.
  assert.deepEqual(todos[2], {
    type: "todo_write",
    todos: [
      { content: "one", status: "completed" },
      { content: "two", status: "pending" },
    ],
  });

  resetProjectionState();
  const cleared = projectThreadEvent({
    type: "item.completed",
    item: { id: "t10", type: "todo_list", items: [] },
  });
  assert.deepEqual(cleared[2], { type: "todo_write", todos: [] });
});

test("error thread item surfaces as an assistant message_end with stopReason error", () => {
  resetProjectionState();
  const out = projectThreadEvent({ type: "item.completed", item: { id: "e1", type: "error", message: "boom" } });
  assert.deepEqual(out, {
    type: "message_end",
    message: { role: "assistant", content: [], stopReason: "error", errorMessage: "boom" },
  });
});

test("turn.failed carries the error payload in turn_end data", () => {
  resetProjectionState();
  const out = projectThreadEvent({ type: "turn.failed", error: { message: "provider 500" } });
  assert.deepEqual(out, { type: "turn_end", data: { error: { message: "provider 500" } } });
});

test("fatal SDK error event → null (client handles failure via onFailure)", () => {
  resetProjectionState();
  assert.equal(projectThreadEvent({ type: "error", message: "stream died" }), null);
});

test("unrecognized or malformed inputs → null, never throws", () => {
  resetProjectionState();
  const malformed = [
    null,
    undefined,
    42,
    "turn.started",
    [],
    {},
    { type: "mystery.event" },
    { type: "item.completed" }, // missing item
    { type: "item.completed", item: null },
    { type: "item.completed", item: { id: "x" } }, // missing item.type
    { type: "item.started", item: { id: "x", type: "agent_message" } }, // ok: empty start
    { type: "item.updated", item: { id: "i9", type: "agent_message" } }, // no text → no growth
    { type: "turn.completed", usage: "nope" }, // non-object usage → bare turn_end
  ];
  for (const evt of malformed) {
    assert.doesNotThrow(() => projectThreadEvent(evt));
  }
  assert.equal(projectThreadEvent(malformed[0]), null);
  assert.equal(projectThreadEvent(malformed[1]), null);
  assert.equal(projectThreadEvent(malformed[2]), null);
  assert.equal(projectThreadEvent(malformed[3]), null);
  assert.equal(projectThreadEvent(malformed[4]), null);
  assert.equal(projectThreadEvent(malformed[5]), null);
  assert.equal(projectThreadEvent(malformed[6]), null);
  assert.equal(projectThreadEvent(malformed[7]), null);
  assert.equal(projectThreadEvent(malformed[8]), null);
  assert.equal(projectThreadEvent(malformed[9]), null);
  assert.deepEqual(malformed[10] && projectThreadEvent(malformed[10]), {
    type: "message_start",
    message: { role: "assistant", content: [] },
  });
  assert.equal(projectThreadEvent(malformed[11]), null);
  assert.deepEqual(projectThreadEvent(malformed[12]), { type: "turn_end" });
});

test("mcp_tool_call carries the model's RAW argument JSON string verbatim", () => {
  resetProjectionState();
  // The SDK hands mcp_tool_call.arguments over as the unparsed string.
  const raw = '{"label": "main", "depth": 2}';
  const pair = projectThreadEvent({
    type: "item.completed",
    item: {
      id: "m3",
      type: "mcp_tool_call",
      server: "graphify",
      tool: "get_node",
      arguments: raw,
      result: { content: [{ type: "text", text: "ok" }] },
      status: "completed",
    },
  });
  // the raw string is authoritative; the display `args` stays the omp shape
  // ({} because the SDK hands the arguments over unparsed)
  assert.equal(pair[0].argumentsJson, raw);
  assert.deepEqual(pair[0].args, {});
});
