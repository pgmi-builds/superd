// src/pi-events.ts — pure projection pi AgentSessionEvent → wire vocabulary.
// Duck-typed on pi's event shapes (verified against @earendil-works/
// pi-agent-core dist 0.84.2); unknown/mapped-out events → null, never throws.
import assert from "node:assert/strict";
import { test } from "node:test";

const { projectSessionEvent } = await import("../dist/pi-events.js");

test("lifecycle events map 1:1", () => {
  assert.deepEqual(projectSessionEvent({ type: "agent_start" }), { type: "agent_start" });
  assert.deepEqual(projectSessionEvent({ type: "turn_start" }), { type: "turn_start" });
  assert.deepEqual(projectSessionEvent({ type: "turn_end" }), { type: "turn_end" });
});

test("agent_end strips its payload to the bare wire event", () => {
  assert.deepEqual(projectSessionEvent({ type: "agent_end", messages: [1, 2], willRetry: false }), { type: "agent_end" });
});

test("message_start/end convert content blocks (args stringified)", () => {
  const userEvent = {
    type: "message_start",
    message: { role: "user", content: [{ type: "text", text: "hi" }] },
  };
  assert.deepEqual(projectSessionEvent(userEvent), {
    type: "message_start",
    message: { role: "user", content: [{ type: "text", text: "hi" }] },
  });

  const assistantEvent = {
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "answer" },
        { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
      ],
      model: "kimi-k3",
      provider: "kimi-plan",
      usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoning: 3 },
      stopReason: "stop",
    },
  };
  assert.deepEqual(projectSessionEvent(assistantEvent), {
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "answer" },
        { type: "toolCall", id: "c1", name: "bash", arguments: JSON.stringify({ command: "ls" }) },
      ],
      model: "kimi-k3",
      provider: "kimi-plan",
      usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoning: 3 },
      stopReason: "stop",
    },
  });
});

test("message_end toolResult keeps toolCallId and isError", () => {
  const event = {
    type: "message_end",
    message: { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "out" }], isError: false },
  };
  assert.deepEqual(projectSessionEvent(event), {
    type: "message_end",
    message: { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "out" }], isError: false },
  });
});

test("message_update passes the assistantMessageEvent through", () => {
  const delta = { type: "text_delta", delta: "ab", contentIndex: 0 };
  assert.deepEqual(projectSessionEvent({ type: "message_update", assistantMessageEvent: delta }), {
    type: "message_update",
    assistantMessageEvent: delta,
  });
});

test("tool execution events pass through with their fields", () => {
  assert.deepEqual(projectSessionEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "/x" } }), {
    type: "tool_execution_start",
    toolCallId: "t1",
    toolName: "read",
    args: { path: "/x" },
  });
  assert.deepEqual(
    projectSessionEvent({ type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: { content: [{ type: "text", text: "out" }] }, isError: true }),
    { type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: { content: [{ type: "text", text: "out" }] }, isError: true },
  );
});

test("pi-specific events project to session_title / compaction pair", () => {
  assert.deepEqual(projectSessionEvent({ type: "session_info_changed", name: "my-feature" }), {
    type: "session_title",
    name: "my-feature",
  });
  assert.deepEqual(projectSessionEvent({ type: "session_info_changed", name: undefined }), {
    type: "session_title",
    name: undefined,
  });
  assert.deepEqual(projectSessionEvent({ type: "compaction_start", reason: "threshold" }), {
    type: "compaction_start",
    reason: "threshold",
  });
  assert.deepEqual(projectSessionEvent({ type: "compaction_end", reason: "manual", result: {}, aborted: false, willRetry: false }), {
    type: "compaction_end",
    aborted: false,
  });
});

test("unmapped and unknown events project to null", () => {
  for (const raw of [
    { type: "agent_settled" },
    { type: "queue_update", steering: [], followUp: [] },
    { type: "entry_appended", entry: {} },
    { type: "thinking_level_changed", level: "high" },
    { type: "auto_retry_start", attempt: 1 },
    { type: "brand_new_future_event" },
    null,
    undefined,
    "junk",
  ]) {
    assert.equal(projectSessionEvent(raw), null, String(raw && raw.type));
  }
});
