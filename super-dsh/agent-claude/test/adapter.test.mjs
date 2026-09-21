// agent-claude/test/adapter.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

const { ClaudeLlmAdapter, CLAUDE_PROVIDER_ID } = await import("../dist/adapter.js");
const { setModelCatalog, readModelCatalog } = await import("../dist/models.js");

test("the adapter serves exactly the observed catalog under the claude route", async () => {
  setModelCatalog([
    { id: "opus", label: "Opus", description: "most capable", contextWindow: 200000 },
    { id: "sonnet", label: "Sonnet" },
  ], "sonnet");
  const adapter = new ClaudeLlmAdapter();
  assert.equal(CLAUDE_PROVIDER_ID, "claude");
  assert.equal(adapter.providerInfo(CLAUDE_PROVIDER_ID).id, "claude");
  assert.deepEqual((await adapter.listModels(CLAUDE_PROVIDER_ID)).map((m) => m.id), ["opus", "sonnet"]);
  const resolved = await adapter.resolveModel(CLAUDE_PROVIDER_ID, "opus");
  assert.equal(resolved.context?.contextWindow, 200000);
  await assert.rejects(() => adapter.resolveModel(CLAUDE_PROVIDER_ID, "gpt"), /does not serve model/);
});

test("an empty catalog stays empty: no placeholder model is ever invented", () => {
  setModelCatalog([]);
  assert.deepEqual(readModelCatalog().models, []);
  assert.equal(readModelCatalog().defaultModel, undefined);
});

test("stream() refuses loudly rather than fabricating a wire route", () => {
  const adapter = new ClaudeLlmAdapter();
  assert.throws(() => adapter.stream({}), /does not stream/);
});

// --- Additional pins for the Task 6 self-review checklist -------------------

const { catalogFromInit } = await import("../dist/models.js");

test("setModelCatalog overwrites rather than merges, and drops a stale default", () => {
  setModelCatalog([{ id: "opus", label: "Opus" }, { id: "haiku", label: "Haiku" }], "opus");
  setModelCatalog([{ id: "sonnet", label: "Sonnet" }]);
  const snapshot = readModelCatalog();
  assert.deepEqual(snapshot.models.map((m) => m.id), ["sonnet"]);
  assert.equal(snapshot.defaultModel, undefined);
});

test("readModelCatalog hands back a detached, immutable snapshot", () => {
  const input = [{ id: "opus", label: "Opus" }];
  setModelCatalog(input, "opus");
  input[0].label = "mutated after the write";
  const first = readModelCatalog();
  assert.throws(() => { first.models.push({ id: "invented", label: "Invented" }); }, TypeError);
  assert.throws(() => { first.models[0].label = "tampered"; }, TypeError);
  const second = readModelCatalog();
  assert.deepEqual(second.models.map((m) => m.id), ["opus"]);
  assert.equal(second.models[0].label, "Opus");
});

test("resolveModel only maps a positive contextWindow, never a zero one", async () => {
  const adapter = new ClaudeLlmAdapter();
  setModelCatalog([
    { id: "zero", label: "Zero", contextWindow: 0 },
    { id: "none", label: "None" },
  ]);
  assert.equal((await adapter.resolveModel(CLAUDE_PROVIDER_ID, "zero")).context, undefined);
  assert.equal((await adapter.resolveModel(CLAUDE_PROVIDER_ID, "none")).context, undefined);
});

test("a default that names no member of the observed catalog is dropped", () => {
  setModelCatalog([{ id: "opus", label: "Opus" }], "sonnet");
  assert.equal(readModelCatalog().defaultModel, undefined);
  setModelCatalog([{ id: "opus", label: "Opus" }], "opus");
  assert.equal(readModelCatalog().defaultModel, "opus");
  setModelCatalog([], "opus");
  assert.deepEqual(readModelCatalog().models, []);
  assert.equal(readModelCatalog().defaultModel, undefined);
});

test("catalogFromInit derives one real entry from the runtime's own model, or none", () => {
  assert.deepEqual(catalogFromInit({ model: "claude-opus-4-1" }), [{ id: "claude-opus-4-1", label: "claude-opus-4-1" }]);
  assert.deepEqual(catalogFromInit({}), []);
  assert.deepEqual(catalogFromInit({ model: "" }), []);
  assert.deepEqual(catalogFromInit({ model: "   " }), []);
  assert.deepEqual(catalogFromInit({ model: 42 }), []);
});
