// agent-claude/test/input-queue.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

const { InputQueue } = await import("../dist/input-queue.js");

test("InputQueue yields pushed items then closes", async () => {
  const q = new InputQueue();
  q.push({ type: "user", message: { role: "user", content: "a" }, parent_tool_use_id: null });
  q.push({ type: "user", message: { role: "user", content: "b" }, parent_tool_use_id: null });
  q.close();
  const seen = [];
  for await (const item of q) seen.push(item.message.content);
  assert.deepEqual(seen, ["a", "b"]);
});

test("InputQueue delivers an item pushed while the consumer is already waiting", async () => {
  const q = new InputQueue();
  const it = q[Symbol.asyncIterator]();
  const pending = it.next();
  q.push({ type: "user", message: { role: "user", content: "late" }, parent_tool_use_id: null });
  const first = await pending;
  assert.equal(first.done, false);
  assert.equal(first.value.message.content, "late");
  q.close();
  assert.equal((await it.next()).done, true);
});

// Ordering decision pinned: close() never discards already-queued items. A
// consumer that starts pulling after close() still sees everything pushed
// beforehand, in FIFO order, and only then observes `done`.
test("close() drains items queued before it, then reports done", async () => {
  const q = new InputQueue();
  q.push({ type: "user", message: { role: "user", content: "queued" }, parent_tool_use_id: null });
  q.close();
  assert.equal(q.closed, true);
  const it = q[Symbol.asyncIterator]();
  const first = await it.next();
  assert.equal(first.done, false);
  assert.equal(first.value.message.content, "queued");
  assert.equal((await it.next()).done, true);
});

test("push() after close() throws and leaves closed observable", () => {
  const q = new InputQueue();
  assert.equal(q.closed, false);
  q.close();
  assert.equal(q.closed, true);
  assert.throws(
    () => q.push({ type: "user", message: { role: "user", content: "nope" }, parent_tool_use_id: null }),
    /input queue is closed/,
  );
});

// T9.6 widening: a queued turn may carry a plain string or transcoded blocks.
// A string keeps the SDK transport normalization (one text block); a block
// array is handed through AS-IS so the block shape survives to the wire.
test("pushContent normalizes a string but hands a block array through unchanged", async () => {
  const q = new InputQueue();
  const blocks = [
    { type: "text", text: "look" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAB" } },
  ];
  q.pushContent("plain", { parent_tool_use_id: null, priority: "now" });
  q.pushContent(blocks, { parent_tool_use_id: null, session_id: "s-1" });
  q.close();
  const seen = [];
  for await (const item of q) seen.push(item);
  assert.deepEqual(seen[0].message.content, [{ type: "text", text: "plain" }]);
  assert.equal(seen[0].priority, "now");
  assert.equal(seen[0].parent_tool_use_id, null);
  assert.deepEqual(seen[1].message.content, blocks, "the block array must not be re-joined or reshaped");
  assert.equal(seen[1].session_id, "s-1");
  assert.equal(seen[1].priority, undefined);
});
