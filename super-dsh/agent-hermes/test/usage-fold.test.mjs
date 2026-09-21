// M1 (2026-09-17) usage fold test: the hermes usage sample must survive the
// upstream DSH token-meter fold. Two layers:
//
//  1. convertUsage (dist/agent.js) maps the gateway's `message.complete.usage`
//     (fixture authority: gateway-events.sample.json index 13) onto Dash
//     TokenUsage, SYNTHESIZING totalTokens = input + output. The gateway's own
//     `total` is context-wide (fixture math: total 26805 = prompt 26803 +
//     completion 2, prompt === context_used), so it must NOT ride the sample.
//  2. deriveTurnTokenUsage (@deepseek-ai/dsh-token-meter, the repo farm build;
//     fallback: the upstream checkout lib) folds a turn's durable events.
//     normalizeUsage needs totalTokens OR both cache buckets — the gateway
//     shape has no cache buckets, so without the synthesized total every
//     hermes turn folded to undefined (the reported "usage missing" finding).
//
// Import path: resolve @deepseek-ai/dsh-token-meter from the node_modules farm;
// fall back to the upstream checkout build when the farm is unavailable.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { convertUsage } = await import("../dist/agent.js");

let deriveTurnTokenUsage;
try {
  ({ deriveTurnTokenUsage } = await import("@deepseek-ai/dsh-token-meter/client"));
} catch {
  ({ deriveTurnTokenUsage } = await import(
    new URL("../../../../upstream/deepseek-harness/packages/llm/token-meter/lib/types/turn-usage.js", import.meta.url)
  ));
}
assert.equal(typeof deriveTurnTokenUsage, "function", "deriveTurnTokenUsage resolved");

const eventsFixture = JSON.parse(
  readFileSync(new URL("./fixtures/gateway-events.sample.json", import.meta.url), "utf8"),
);
/** The live `message.complete.usage` (gateway-events.sample.json index 13). */
const gatewayUsage = eventsFixture.turn["11"].frame.params.payload.usage;
assert.ok(gatewayUsage && gatewayUsage.input === 19251, "fixture usage present");

/** Minimal durable turn slice, shaped exactly like the agent appends it. */
function turnEvents(usage, { toolTurn = false, seqStart = 1 } = {}) {
  let seq = seqStart;
  const ev = (type, data) => ({ type, seq: seq++, time: 0, data });
  const events = [ev("turn/start", { turn: 1 }), ev("step/start", { turn: 1, step: 1 })];
  if (toolTurn) {
    events.push(
      ev("tool/call", { turn: 1, step: 1, callId: "c1", name: "terminal", arguments: "{}" }),
      ev("tool/result", { turn: 1, step: 1, message: { callId: "c1", content: [{ type: "text", text: "ok" }] } }),
    );
  }
  events.push(
    ev("assistant/message", {
      turn: 1,
      step: 1,
      message: { role: "assistant", content: [{ type: "text", text: "ok" }], source: { provider: "deepseek", model: "deepseek-v4-pro" } },
      stream: [],
      usage,
    }),
    ev("step/end", { turn: 1, step: 1 }),
    ev("turn/end", { turn: 1, reason: { kind: "completed" } }),
  );
  return events;
}

test("fixture verdict: the gateway `total` is context-wide — convertUsage synthesizes input+output", () => {
  const sample = convertUsage(gatewayUsage);
  // Fixture math: total 26805 = prompt 26803 + completion 2, prompt === context_used.
  assert.equal(gatewayUsage.total, gatewayUsage.prompt + gatewayUsage.completion);
  assert.equal(gatewayUsage.prompt, gatewayUsage.context_used);
  assert.deepEqual(sample, { inputTokens: 19251, outputTokens: 2, totalTokens: 19253, reasoningTokens: 0 });
  assert.notEqual(sample.totalTokens, gatewayUsage.total, "the context-wide total must NOT ride the sample");
  // no cache tokens invented (the gateway shape has none — cache_hit_pct is a percentage)
  assert.equal(sample.cacheReadTokens, undefined);
  assert.equal(sample.cacheWriteTokens, undefined);
});

test("fold: a TEXT turn with the converted sample yields DEFINED usage (was undefined before the fix)", () => {
  const sample = convertUsage(gatewayUsage);
  const turn = deriveTurnTokenUsage(turnEvents(sample));
  assert.ok(turn, "the fold accepts the sample");
  assert.equal(turn.uncachedInputTokens, 19251);
  assert.equal(turn.outputTokens, 2);
  assert.equal(turn.totalTokens, 19253);
  assert.deepEqual(turn.routes, [{ provider: "deepseek", model: "deepseek-v4-pro" }]);
});

test("fold: a TOOL turn (tool pair + message + usage on the same step) yields DEFINED usage", () => {
  const sample = convertUsage(gatewayUsage);
  const turn = deriveTurnTokenUsage(turnEvents(sample, { toolTurn: true }));
  assert.ok(turn, "tool turns fold — the sample rides the step's assistant/message");
  assert.equal(turn.totalTokens, 19253);
});

test("fold control: the pre-fix sample shape (no totalTokens, no cache buckets) folds to undefined", () => {
  const legacy = { inputTokens: gatewayUsage.input, outputTokens: gatewayUsage.output, reasoningTokens: 0 };
  assert.equal(deriveTurnTokenUsage(turnEvents(legacy)), undefined, "documents WHY the synthesized total is required");
});

test("fold control: trusting the gateway `total` would fold but inflate (26805 vs 19253)", () => {
  const inflated = { ...convertUsage(gatewayUsage), totalTokens: gatewayUsage.total };
  const turn = deriveTurnTokenUsage(turnEvents(inflated));
  assert.ok(turn);
  assert.equal(turn.totalTokens, 26805, "the fold cannot know the gateway total is context-wide — we must not feed it");
});
