// src/models.ts — ModelRuntime seam + memoized pi model catalog.
// The runtime singleton is injectable (setPiModelRuntimeFactory) so unit
// tests never import the real SDK; the catalog memo fills on warmPiCatalog()
// and readPiModelCatalog() is a synchronous memo read. Entries carry their
// REAL provider slug + BARE model id; the picker routes are the distinct
// slugs (piProviderIds — settings default first, then alphabetical).
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const models = await import("../dist/models.js");
const {
  PI_PROVIDER_ID,
  setPiModelRuntimeFactory,
  warmPiCatalog,
  readPiModelCatalog,
  splitCatalogId,
  piProviderIds,
  providerDisplayName,
  resolvePiSelection,
  clearPiCatalogForTests,
} = models;

function tempPiAgentDir(settings) {
  const dir = mkdtempSync(join(tmpdir(), "aw-pi-models-"));
  mkdirSync(dir, { recursive: true });
  if (settings !== undefined) writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
  return dir;
}

const FAKE_MODELS = [
  { id: "m1", provider: "prov-a", name: "M One", contextWindow: 100000 },
  { id: "m2", provider: "prov-b", name: "M Two" },
];

function fakeRuntime() {
  let getCalls = 0;
  return {
    calls: () => getCalls,
    getAvailable: async () => {
      getCalls += 1;
      return FAKE_MODELS.map((m) => ({ ...m }));
    },
    getModel: (provider, id) => FAKE_MODELS.find((m) => m.provider === provider && m.id === id),
  };
}

test("PI_PROVIDER_ID is the pi boot placeholder route", () => {
  assert.equal(PI_PROVIDER_ID, "pi");
});

test("warm fills the memo; sync read exposes bare ids, labels, context window, served default", async () => {
  const dir = tempPiAgentDir({ defaultProvider: "prov-a", defaultModel: "m1", defaultThinkingLevel: "off" });
  process.env.PI_CODING_AGENT_DIR = dir;
  clearPiCatalogForTests();
  let factoryCalls = 0;
  setPiModelRuntimeFactory(async () => {
    factoryCalls += 1;
    return fakeRuntime();
  });

  await warmPiCatalog();
  await warmPiCatalog(); // idempotent: singleton + memo
  assert.equal(factoryCalls, 1);

  const catalog = readPiModelCatalog();
  assert.equal(catalog.provider, "pi");
  assert.equal(catalog.models.length, 2);
  assert.deepEqual(
    catalog.models.map((m) => m.id),
    ["m1", "m2"], // BARE ids — the composite prefix is dropped at the picker boundary
  );
  assert.deepEqual(
    catalog.models.map((m) => m.provider),
    ["prov-a", "prov-b"],
  );
  assert.equal(catalog.models[0].label, "M One");
  assert.equal(catalog.models[0].contextWindow, 100000);
  assert.deepEqual(catalog.defaultSelection, { provider: "prov-a", model: "m1" });

  delete process.env.PI_CODING_AGENT_DIR;
  clearPiCatalogForTests();
});

test("a settings default that is not in the available list degrades to no default selection", async () => {
  const dir = tempPiAgentDir({ defaultProvider: "prov-x", defaultModel: "missing" });
  process.env.PI_CODING_AGENT_DIR = dir;
  clearPiCatalogForTests();
  setPiModelRuntimeFactory(async () => fakeRuntime());
  await warmPiCatalog();
  assert.equal(readPiModelCatalog().defaultSelection, undefined);
  delete process.env.PI_CODING_AGENT_DIR;
  clearPiCatalogForTests();
});

test("cold catalog (never warmed) reads empty with no default selection", () => {
  clearPiCatalogForTests();
  const catalog = readPiModelCatalog();
  assert.deepEqual(catalog.models, []);
  assert.equal(catalog.defaultSelection, undefined);
});

test("piProviderIds groups by distinct slug: settings default leads, rest alphabetical", async () => {
  const dir = tempPiAgentDir({ defaultProvider: "zai", defaultModel: "glm" });
  process.env.PI_CODING_AGENT_DIR = dir;
  clearPiCatalogForTests();
  setPiModelRuntimeFactory(async () => ({
    getAvailable: async () => [
      { id: "glm", provider: "zai", name: "GLM" },
      { id: "v4-pro", provider: "deepseek", name: "DeepSeek v4 Pro" },
      { id: "v4-flash", provider: "deepseek", name: "DeepSeek v4 Flash" },
      { id: "sonnet", provider: "anthropic", name: "Claude Sonnet" },
    ],
    getModel: () => undefined,
  }));
  await warmPiCatalog();

  // operator-wired provider (pi settings default) first — omp modelRoles pattern
  assert.deepEqual(piProviderIds(), ["zai", "anthropic", "deepseek"]);
  // distinct slugs only: deepseek's two models collapse into one route
  assert.deepEqual(piProviderIds(readPiModelCatalog().models), ["zai", "anthropic", "deepseek"]);

  // no settings default (empty temp agent dir): purely alphabetical
  process.env.PI_CODING_AGENT_DIR = tempPiAgentDir(undefined);
  assert.deepEqual(piProviderIds(), ["anthropic", "deepseek", "zai"]);

  delete process.env.PI_CODING_AGENT_DIR;
  clearPiCatalogForTests();
});

test("providerDisplayName maps known slugs and capitalizes the fallback", () => {
  assert.equal(providerDisplayName("deepseek"), "DeepSeek");
  assert.equal(providerDisplayName("zai"), "Z.AI");
  assert.equal(providerDisplayName("xai"), "xAI");
  assert.equal(providerDisplayName("openrouter"), "OpenRouter");
  assert.equal(providerDisplayName("kimi-plan"), "Kimi-plan");
  assert.equal(providerDisplayName("prov-a"), "Prov-a");
});

test("resolvePiSelection: real slug pairs pass through (even with slashes in the bare id)", async () => {
  const dir = tempPiAgentDir({ defaultProvider: "prov-a", defaultModel: "m1" });
  process.env.PI_CODING_AGENT_DIR = dir;
  clearPiCatalogForTests();
  setPiModelRuntimeFactory(async () => fakeRuntime());
  await warmPiCatalog(); // memo serves prov-a/m1 + prov-b/m2

  assert.deepEqual(resolvePiSelection("prov-a", "m1"), { provider: "prov-a", model: "m1" });
  // a real-slug bare id may itself contain a slash — it must NOT be re-split
  setPiModelRuntimeFactory(async () => ({
    getAvailable: async () => [{ id: "deepseek/deepseek-chat", provider: "openrouter", name: "DS Chat" }],
    getModel: () => undefined,
  }));
  clearPiCatalogForTests();
  await warmPiCatalog();
  assert.deepEqual(resolvePiSelection("openrouter", "deepseek/deepseek-chat"), {
    provider: "openrouter",
    model: "deepseek/deepseek-chat",
  });

  delete process.env.PI_CODING_AGENT_DIR;
  clearPiCatalogForTests();
});

test("resolvePiSelection: legacy composite under the umbrella pi route splits to the real pair", async () => {
  const dir = tempPiAgentDir(undefined);
  process.env.PI_CODING_AGENT_DIR = dir;
  clearPiCatalogForTests();
  setPiModelRuntimeFactory(async () => fakeRuntime());
  await warmPiCatalog();

  assert.deepEqual(resolvePiSelection("pi", "prov-a/m1"), { provider: "prov-a", model: "m1" });
  assert.deepEqual(resolvePiSelection(undefined, "prov-b/m2"), { provider: "prov-b", model: "m2" });
  assert.deepEqual(resolvePiSelection("", "prov-a/m1"), { provider: "prov-a", model: "m1" });

  delete process.env.PI_CODING_AGENT_DIR;
  clearPiCatalogForTests();
});

test("resolvePiSelection: unserved pairs degrade to undefined when warm; cold memo passes through", async () => {
  const dir = tempPiAgentDir(undefined);
  process.env.PI_CODING_AGENT_DIR = dir;
  clearPiCatalogForTests();
  setPiModelRuntimeFactory(async () => fakeRuntime());
  await warmPiCatalog(); // warm memo: prov-a/m1, prov-b/m2

  assert.equal(resolvePiSelection("prov-a", "nope"), undefined);
  assert.equal(resolvePiSelection("prov-x", "m1"), undefined);
  assert.equal(resolvePiSelection("prov-a", ""), undefined);
  assert.equal(resolvePiSelection("prov-a", undefined), undefined);

  // cold memo: no verification here — the runtime lookup validates later
  clearPiCatalogForTests();
  assert.deepEqual(resolvePiSelection("prov-a", "m1"), { provider: "prov-a", model: "m1" });

  delete process.env.PI_CODING_AGENT_DIR;
  clearPiCatalogForTests();
});

test("splitCatalogId splits on the first slash and rejects bare ids (legacy path only)", () => {
  assert.deepEqual(splitCatalogId("prov-a/m1"), { provider: "prov-a", modelId: "m1" });
  assert.deepEqual(splitCatalogId("scoped/provider/id"), { provider: "scoped", modelId: "provider/id" });
  assert.equal(splitCatalogId("nodash"), undefined);
  assert.equal(splitCatalogId(""), undefined);
});
