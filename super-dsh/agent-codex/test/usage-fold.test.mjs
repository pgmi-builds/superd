// Plan X1 / RC-6 — turn-usage fold fixture test.
// The SAME-TURN usage landing (agent defers the final assistant/message to
// turn_end) is what makes `deriveTurnTokenUsage` able to prove the turn's
// attempt. These tests run the upstream fold over event sequences shaped
// exactly like the durable log this adapter appends, using usage converted by
// convertUsage (codex counters → Dash TokenUsage, reasoning ADDITIVE).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const { deriveTurnTokenUsage } = await import("@deepseek-ai/dsh-token-meter/client");
const { convertUsage } = await import("../dist/agent.js");

const FIXTURE = JSON.parse(
  readFileSync(join(new URL(".", import.meta.url).pathname, "fixtures", "thread-events.sample.json"), "utf8"),
);

const ROUTE = { provider: "codex", model: "gpt-5.1-codex" };

/** An assistant/message event shaped like the adapter's append (usage + source route). */
function assistantMessage(turn, step, usage, text = "ok") {
  return {
    type: "assistant/message",
    data: {
      turn,
      step,
      message: { content: [{ type: "text", text }], source: { ...ROUTE } },
      stream: [],
      ...(usage === undefined ? {} : { usage }),
    },
  };
}

function toolEvents(turn, step) {
  return [
    { type: "tool/call", data: { turn, step, callId: "c1", name: "command_execution", arguments: '{"command":"ls"}' } },
    { type: "tool/result", data: { turn, step, message: { callId: "c1", content: [{ type: "text", text: "files" }], isError: false } } },
  ];
}

/** Wrap the turn-local event slice the fold consumes (turn/start … turn/end). */
function turnEvents(turn, inner) {
  return [
    { type: "turn/start", data: { turn } },
    { type: "step/start", data: { turn, step: 1 } },
    ...inner,
    { type: "step/end", data: { turn, step: 1 } },
    { type: "turn/end", data: { turn, reason: { kind: "completed" } } },
  ];
}

test("(a) text turn from the fixture shape: usage on the SAME turn folds to a DEFINED total", () => {
  // thread-events.sample.json: input 1234, cached 0, cache_write 0, output 3, reasoning 18 (ADDITIVE).
  const usage = convertUsage(FIXTURE.events[4].usage);
  assert.ok(usage !== undefined);
  assert.equal(usage.inputTokens, 1234);
  assert.equal(usage.outputTokens, 3);
  // Synthesized total from codex's own counters, reasoning included.
  assert.equal(usage.totalTokens, 1234 + 0 + 0 + 3 + 18);
  // reasoning 18 > output 3 → omitted from the breakdown (fold's subset rule).
  assert.equal(usage.reasoningTokens, undefined);

  const events = turnEvents(1, [assistantMessage(1, 1, usage)]);
  const fold = deriveTurnTokenUsage(events);
  assert.ok(fold !== undefined, "text-turn usage must fold");
  assert.equal(fold.totalTokens, 1255);
  assert.equal(fold.outputTokens, 3);
  assert.equal(fold.uncachedInputTokens, 1234);
  assert.equal(fold.reasoningTokens, undefined);
});

test("(b) tool turn: same-turn usage on the final assistant message folds through the tool pair", () => {
  const usage = convertUsage(FIXTURE.events[4].usage);
  const events = turnEvents(1, [
    ...toolEvents(1, 1),
    // One assistant/message per step (the fold's attempt model): the tool
    // pair sits in the step, then the final message lands the turn's usage —
    // exactly the deferred turn_end flush's durable order.
    assistantMessage(1, 1, usage),
  ]);
  const fold = deriveTurnTokenUsage(events);
  assert.ok(fold !== undefined, "tool-turn usage must fold");
  assert.equal(fold.totalTokens, 1255);
});

test("reasoning within the output budget rides through and still folds", () => {
  const usage = convertUsage({ input_tokens: 100, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 20 });
  assert.equal(usage.reasoningTokens, 20);
  assert.equal(usage.totalTokens, 170);
  const fold = deriveTurnTokenUsage(turnEvents(2, [assistantMessage(2, 1, usage)]));
  assert.ok(fold !== undefined);
  assert.equal(fold.reasoningTokens, 20);
  assert.equal(fold.totalTokens, 170);
});

test("nonzero cache buckets ride through and keep the fold exact", () => {
  const usage = convertUsage({ input_tokens: 100, cached_input_tokens: 30, cache_write_input_tokens: 5, output_tokens: 50, reasoning_output_tokens: 0 });
  assert.equal(usage.cacheReadTokens, 30);
  assert.equal(usage.cacheWriteTokens, 5);
  assert.equal(usage.totalTokens, 185);
  const fold = deriveTurnTokenUsage(turnEvents(3, [assistantMessage(3, 1, usage)]));
  assert.ok(fold !== undefined);
  assert.equal(fold.totalTokens, 185);
  assert.equal(fold.cacheReadTokens, 30);
});

test("control: the OLD shape (reasoning > output kept as a subset) folds to undefined", () => {
  // This is precisely why convertUsage omits codex's additive reasoning when
  // it exceeds outputTokens — upstream normalizeUsage rejects reasoning > output.
  const oldShape = { inputTokens: 1234, outputTokens: 3, reasoningTokens: 18, totalTokens: 1255 };
  assert.equal(deriveTurnTokenUsage(turnEvents(1, [assistantMessage(1, 1, oldShape)])), undefined);
});

test("control: usage on the NEXT turn's message (the old 1-turn lag) folds to undefined", () => {
  // The defect class the deferral removes: the sample rides a message of a
  // LATER turn, so each turn's attempt carries no sample → no disclosure.
  const usage = convertUsage(FIXTURE.events[4].usage);
  const lagged = [
    { type: "turn/start", data: { turn: 1 } },
    { type: "step/start", data: { turn: 1, step: 1 } },
    assistantMessage(1, 1, undefined), // turn 1's final message: NO usage (old code lagged it)
    { type: "step/end", data: { turn: 1, step: 1 } },
    { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
  ];
  assert.equal(deriveTurnTokenUsage(lagged), undefined);
  assert.ok(usage !== undefined);
});
