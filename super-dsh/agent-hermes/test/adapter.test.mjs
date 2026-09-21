// M1 (2026-09-17): HermesLlmAdapter — one route per REAL gateway provider slug
// (parity ruling; the provider boots with the placeholder `hermes` route and
// atomically handle.replace()s to these slugs once the first catalog probe
// resolves). Fixture authority: gateway-rpc-samples.json model.options
// (17 providers, 579 raw models → trimmed to 14 groups / 526 unique ids).
// Model ids stay the VERBATIM gateway selection strings; the r4 dedupe keeps
// one canonical provider per id, so each route lists exactly the ids that
// resolve under it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const { HermesLlmAdapter, HERMES_PROVIDER_ID } = await import("../dist/adapter.js");
const { hermesProviderDisplayName, hermesProviderSlugs, resetHermesModelCatalogCache, resetHermesProviderInfoCache } =
  await import("../dist/models.js");

const modelOptionsResult = JSON.parse(
  readFileSync(new URL("./fixtures/gateway-rpc-samples.json", import.meta.url), "utf8"),
).samples["model.options"].result;

function fixtureAdapter() {
  // Production parity: the provider's supplier goes through
  // readHermesModelCatalog (single-flight + provider-name learning).
  return new HermesLlmAdapter(async () => {
    const { readHermesModelCatalog } = await import("../dist/models.js");
    return readHermesModelCatalog({ async modelOptions() { return modelOptionsResult; } }, { ttlMs: 0 });
  });
}


test("adapter: listModels filters by the entry's real provider slug", async () => {
  const adapter = fixtureAdapter();
  const openrouter = await adapter.listModels("openrouter");
  assert.equal(openrouter.length, 47, "openrouter route lists exactly its own models");
  assert.ok(openrouter.every((model) => model.provider === "openrouter"));
  assert.ok(openrouter.some((model) => model.id === "anthropic/claude-opus-5"));
  const deepseek = await adapter.listModels("deepseek");
  assert.deepEqual(deepseek.map((model) => model.id), ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-flash"]);
  // the mirrored/trimmed endpoints expose NO route of their own
  assert.deepEqual(await adapter.listModels("copilot-acp"), []);
  assert.deepEqual(await adapter.listModels("moa"), []);
  assert.deepEqual(await adapter.listModels("zhipu"), []);
});

test("adapter: routes partition the trimmed catalog (every id listed exactly once, across all slugs)", async () => {
  const adapter = fixtureAdapter();
  const slugs = hermesProviderSlugs((await import("../dist/models.js")).mapHermesModelOptions(modelOptionsResult));
  assert.equal(slugs.length, 14, "14 real provider groups after the trims");
  const all = [];
  for (const slug of slugs) all.push(...(await adapter.listModels(slug)));
  assert.equal(all.length, 526, "partition covers the whole trimmed catalog");
  assert.equal(new Set(all.map((model) => model.id)).size, 526, "no id is listed under two routes");
  // ids are the VERBATIM gateway selection strings
  assert.ok(all.some((model) => model.id === "anthropic/claude-opus-5"));
  assert.ok(all.some((model) => model.id === "kimi-k3"));
});

test("adapter: resolveModel is provider-aware — a route only serves ids listed under it", async () => {
  const adapter = fixtureAdapter();
  const resolved = await adapter.resolveModel("deepseek", "deepseek-v4-pro");
  assert.equal(resolved.provider, "deepseek");
  assert.equal(resolved.id, "deepseek-v4-pro");
  // canonical dedupe: kimi-k3 is listed under copilot only — another route refuses
  await assert.rejects(() => adapter.resolveModel("kimi-cn", "kimi-k3"), /MODEL_NOT_FOUND|does not serve/);
  await assert.rejects(() => adapter.resolveModel("deepseek", "anthropic/claude-opus-5"), /does not serve/);
});

test("adapter: providerInfo serves the last-known gateway row name; capitalize fallback pre-fetch", async () => {
  resetHermesModelCatalogCache();
  resetHermesProviderInfoCache();
  const adapter = fixtureAdapter();
  // pre-fetch: the placeholder route renders as "Hermes", slugs as capitalized
  assert.deepEqual(adapter.providerInfo(HERMES_PROVIDER_ID), { id: "hermes", name: "Hermes" });
  assert.deepEqual(adapter.providerInfo("openrouter"), { id: "openrouter", name: "Openrouter" });
  // one catalog read teaches the adapter the human names (module-level cache)
  await adapter.listModels("openrouter");
  assert.deepEqual(adapter.providerInfo("openrouter"), { id: "openrouter", name: "OpenRouter" });
  assert.deepEqual(adapter.providerInfo("deepseek"), { id: "deepseek", name: "DeepSeek" });
  assert.deepEqual(adapter.providerInfo("qwen-cn"), { id: "qwen-cn", name: "qwen-cn" });
  assert.deepEqual(adapter.providerInfo("vertex"), { id: "vertex", name: "Google Vertex AI" });
  assert.equal(hermesProviderDisplayName("never-seen"), "Never-seen");
});

test("adapter: stream is never dispatched (Hermes owns generation through the gateway child)", () => {
  const adapter = fixtureAdapter();
  assert.throws(() => adapter.stream({}), /UNSUPPORTED_STREAM|does not stream/);
});
