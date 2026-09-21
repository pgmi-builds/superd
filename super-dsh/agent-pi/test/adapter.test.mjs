// src/adapter.ts — Pi-backed LlmAdapter serving the browser model selector
// from the warmed catalog: per-provider routes (listModels filters by the
// provider slug), bare model ids, display-name providerInfo; never streams.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const models = await import("../dist/models.js");
const { setPiModelRuntimeFactory, warmPiCatalog, clearPiCatalogForTests } = models;
const { PiLlmAdapter } = await import("../dist/adapter.js");

function tempPiAgentDir(settings) {
  const dir = mkdtempSync(join(tmpdir(), "aw-pi-adapter-"));
  mkdirSync(dir, { recursive: true });
  if (settings !== undefined) writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
  return dir;
}

test("listModels filters per provider route and serves bare ids; resolve/providerInfo answer per route", async () => {
  const dir = tempPiAgentDir(undefined);
  process.env.PI_CODING_AGENT_DIR = dir;
  clearPiCatalogForTests();
  setPiModelRuntimeFactory(async () => ({
    getAvailable: async () => [
      { id: "m1", provider: "deepseek", name: "DeepSeek One", contextWindow: 100000 },
      { id: "m2", provider: "deepseek", name: "DeepSeek Two" },
      { id: "glm", provider: "zai", name: "GLM" },
    ],
    getModel: () => undefined,
  }));
  await warmPiCatalog();

  const adapter = new PiLlmAdapter();

  // deepseek route lists ONLY deepseek models, with bare ids
  const deepseek = await adapter.listModels("deepseek");
  assert.deepEqual(deepseek.map((m) => m.id), ["m1", "m2"]);
  assert.ok(deepseek.every((m) => m.provider === "deepseek"));
  assert.equal(deepseek[0].name, "DeepSeek One");

  const zai = await adapter.listModels("zai");
  assert.deepEqual(zai.map((m) => m.id), ["glm"]);
  assert.ok(zai.every((m) => m.provider === "zai"));

  // unknown/unserved route lists nothing
  assert.deepEqual(await adapter.listModels("unknown"), []);

  // resolveModel is per-route: the bare id resolves only under its own slug
  const resolved = await adapter.resolveModel("deepseek", "m1");
  assert.equal(resolved.provider, "deepseek");
  assert.equal(resolved.id, "m1");
  assert.equal(resolved.name, "DeepSeek One");
  assert.equal(resolved.context?.contextWindow, 100000);
  await assert.rejects(() => adapter.resolveModel("deepseek", "glm"), /does not serve model/);
  await assert.rejects(() => adapter.resolveModel("zai", "m1"), /does not serve model/);
  await assert.rejects(() => adapter.resolveModel("unknown", "m1"), /does not serve model/);

  // providerInfo serves display names per slug (titles map + capitalize fallback)
  assert.deepEqual(adapter.providerInfo("deepseek"), { id: "deepseek", name: "DeepSeek" });
  assert.deepEqual(adapter.providerInfo("zai"), { id: "zai", name: "Z.AI" });
  assert.deepEqual(adapter.providerInfo("kimi-plan"), { id: "kimi-plan", name: "Kimi-plan" });

  assert.throws(() => adapter.stream({}), /does not stream/);

  delete process.env.PI_CODING_AGENT_DIR;
  clearPiCatalogForTests();
});
