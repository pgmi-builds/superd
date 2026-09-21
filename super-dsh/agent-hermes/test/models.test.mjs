// Task 5 TDD (RED first): src/models.ts — gateway `model.options` → Dash model
// catalog. Field-name authority = the Task 1 LIVE capture
// (test/fixtures/gateway-rpc-samples.json, samples["model.options"].result):
// top level {providers:[<row>...], model, provider}; rows carry plain model-id
// strings + a capabilities map keyed by the same ids. Covers: mapping verbatim
// ids / provider slugs / top-level default; the authenticated/is_current row
// filter; capability-hint labels; fail-soft empty catalog for missing client /
// failing RPC / garbage shapes (never throws); the module-level single-world
// TTL cache (reset hook, ttlMs override, single-flight, probe-client pattern).
// No gateway spawn: every client is a fake object over the fixture or
// hand-built shapes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const { readHermesModelCatalog, mapHermesModelOptions, resetHermesModelCatalogCache } = await import(
  "../dist/models.js"
);

const rpcUrl = new URL("./fixtures/gateway-rpc-samples.json", import.meta.url);
const modelOptionsResult = JSON.parse(readFileSync(rpcUrl, "utf8")).samples["model.options"].result;

/** Fake probe client: counts invocations, resolves the given result or throws it. */
function fakeClient(result) {
  const client = {
    calls: 0,
    async modelOptions() {
      client.calls += 1;
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return client;
}

/** The trimmed + deduped live-fixture count (hardcoded, not mirrored from the predicate).
 *  579 raw entries → trims drop the virtual `moa` row (2) and the mirrored
 *  `copilot-acp` (27) + `zhipu` (10) rows → 540, minus 14 cross-provider
 *  duplicate ids among the surviving rows (counted once from the fixture) →
 *  526 unique model ids across 14 provider groups. */
function expectedFixtureCount() {
  return 526;
}

/** The 14 provider slugs that survive the trims, in gateway order (hardcoded). */
function expectedFixtureSlugs() {
  return [
    "openrouter", "xiaomi", "copilot", "gemini", "vertex", "deepseek", "xai", "minimax",
    "opencode-free", "qwen-cn", "ark-coding-plan", "zai-plan", "kimi-cn", "kimi-code",
  ];
}

test("public API + fixture: trimmed catalog mapped verbatim (ids, provider slugs, top-level default)", async () => {
  resetHermesModelCatalogCache();
  const catalog = await readHermesModelCatalog(fakeClient(modelOptionsResult));
  assert.equal(catalog.provider, "deepseek");
  assert.equal(catalog.defaultModel, "deepseek-v4-pro");
  assert.equal(catalog.models.length, expectedFixtureCount());
  // the current provider's row maps verbatim, in row order
  const deepseek = catalog.models.filter((entry) => entry.provider === "deepseek");
  assert.deepEqual(deepseek.map((entry) => entry.id), ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-flash"]);
  // ids are the raw selection strings — cross-provider slugs keep their prefix
  assert.ok(catalog.models.some((entry) => entry.id === "anthropic/claude-opus-5" && entry.provider === "openrouter"));
  // trims (2026-09-17 ruling): NO virtual rows, NO mirrored endpoints
  assert.ok(catalog.models.every((entry) => entry.provider !== "moa"), "virtual moa row dropped");
  assert.ok(catalog.models.every((entry) => entry.provider !== "copilot-acp"), "copilot-acp mirror collapsed into copilot");
  assert.ok(catalog.models.some((entry) => entry.provider === "copilot"), "the surviving copilot row stays");
  assert.ok(catalog.models.every((entry) => entry.provider !== "zhipu"), "zhipu mirror collapsed into zai-plan");
  assert.ok(catalog.models.some((entry) => entry.provider === "zai-plan"), "the surviving zai-plan row stays");
  // 14 distinct provider groups in gateway order
  const { hermesProviderSlugs } = await import("../dist/models.js");
  assert.deepEqual(hermesProviderSlugs(catalog), expectedFixtureSlugs());
  // row names survive for the providerInfo surface
  assert.equal(catalog.providerNames["openrouter"], "OpenRouter");
  assert.equal(catalog.providerNames["deepseek"], "DeepSeek");
  assert.equal(catalog.providerNames["qwen-cn"], "qwen-cn"); // the gateway's own (unprefixed) name
  // order preserved: first entry = first model of the first included row (openrouter ≤ 50 models keeps gateway order)
  assert.equal(catalog.models[0].id, modelOptionsResult.providers[0].models[0]);
  // no invented contextWindow anywhere (gateway capabilities carry none — Task 1 §3⑦)
  assert.ok(catalog.models.every((entry) => !("contextWindow" in entry)));
});

test("trims: per-route filter (listModels semantics) — the deepseek route lists exactly the deepseek models", async () => {
  const catalog = mapHermesModelOptions(modelOptionsResult);
  const deepseek = catalog.models.filter((entry) => entry.provider === "deepseek");
  assert.equal(deepseek.length, 3);
  assert.ok(deepseek.some((entry) => entry.id === catalog.defaultModel), "the gateway default resolves on its canonical route");
});

test("trim 3: featured-first ordering applies ONLY to endpoints with more than 50 models", () => {
  const bigModels = Array.from({ length: 55 }, (_, i) => `model-${String(i).padStart(2, "0")}`);
  const featured = ["model-40", "model-07", "model-19", "not-in-list", "model-40"]; // foreign + duplicate ids ignored
  const catalog = mapHermesModelOptions({
    providers: [
      { slug: "big", name: "Big", models: bigModels, authenticated: true, featured_models: featured },
      { slug: "small", name: "Small", models: ["m-b", "m-a", "m-c"], authenticated: true, featured_models: ["m-c"] },
    ],
  });
  const big = catalog.models.filter((entry) => entry.provider === "big").map((entry) => entry.id);
  // > 50 models: featured (list order, foreign/dup entries dropped) then the rest alphabetically
  assert.deepEqual(big.slice(0, 3), ["model-40", "model-07", "model-19"]);
  assert.deepEqual(big.slice(3), big.slice(3).sort((a, b) => a.localeCompare(b)));
  assert.equal(big.length, 55);
  // ≤ 50 models: gateway order untouched (featured_models ignored)
  const small = catalog.models.filter((entry) => entry.provider === "small").map((entry) => entry.id);
  assert.deepEqual(small, ["m-b", "m-a", "m-c"]);
});

test("trim 2: mirrored endpoints collapse onto one row — first wins, a later is_current row displaces", () => {
  const mirrored = ["x1", "x2"];
  const firstWins = mapHermesModelOptions({
    providers: [
      { slug: "main", name: "Main", models: mirrored, authenticated: true, source: "built-in" },
      { slug: "mirror", name: "Mirror", models: ["x2", "x1"], authenticated: true, source: "hermes" },
    ],
  });
  assert.deepEqual(firstWins.models.map((entry) => entry.provider), ["main", "main"]);
  const currentDisplaces = mapHermesModelOptions({
    providers: [
      { slug: "main", name: "Main", models: mirrored, authenticated: true, source: "built-in" },
      { slug: "mirror", name: "Mirror", models: ["x2", "x1"], authenticated: true, source: "hermes", is_current: true },
    ],
    model: "x1",
    provider: "mirror",
  });
  assert.deepEqual(currentDisplaces.models.map((entry) => entry.provider), ["mirror", "mirror"]);
  // near-mirror (different sets) does NOT collapse
  const notMirror = mapHermesModelOptions({
    providers: [
      { slug: "a", name: "A", models: ["x1", "x2"], authenticated: true },
      { slug: "b", name: "B", models: ["x1", "x3"], authenticated: true },
    ],
  });
  assert.ok(notMirror.models.some((entry) => entry.provider === "a"));
  assert.ok(notMirror.models.some((entry) => entry.provider === "b"));
});

test("trim 1: source virtual rows drop even when authenticated and current", () => {
  const catalog = mapHermesModelOptions({
    providers: [
      { slug: "virt", name: "Virt", models: ["v1"], authenticated: true, source: "virtual", is_current: true },
      { slug: "real", name: "Real", models: ["r1"], authenticated: true, source: "user-config" },
    ],
    model: "v1",
    provider: "virt",
  });
  assert.deepEqual(catalog.models.map((entry) => entry.id), ["r1"]);
});

// ---- providerInfo surface: last-known-catalog display-name cache ----

test("providerInfo cache: capitalized-slug fallback before any fetch; row names after a successful fetch", async () => {
  const { hermesProviderDisplayName, resetHermesProviderInfoCache } = await import("../dist/models.js");
  resetHermesModelCatalogCache();
  resetHermesProviderInfoCache();
  // Before the first fetch only the capitalized slug is available.
  assert.equal(hermesProviderDisplayName("openrouter"), "Openrouter");
  assert.equal(hermesProviderDisplayName("hermes"), "Hermes");
  // A successful fetch learns the gateway's human row names.
  await readHermesModelCatalog(fakeClient(modelOptionsResult));
  assert.equal(hermesProviderDisplayName("openrouter"), "OpenRouter");
  assert.equal(hermesProviderDisplayName("deepseek"), "DeepSeek");
  assert.equal(hermesProviderDisplayName("qwen-cn"), "qwen-cn"); // verbatim row name
  assert.equal(hermesProviderDisplayName("hermes"), "Hermes"); // capitalize fallback for unnamed slugs
  assert.equal(hermesProviderDisplayName(""), "Hermes"); // empty slug → the fail-soft brand
  // The reset seam clears the learned names.
  resetHermesProviderInfoCache();
  assert.equal(hermesProviderDisplayName("openrouter"), "Openrouter");
});

test("providerInfo cache: a failed or empty fetch leaves the last-known names intact", async () => {
  const { hermesProviderDisplayName, resetHermesProviderInfoCache } = await import("../dist/models.js");
  resetHermesModelCatalogCache();
  resetHermesProviderInfoCache();
  await readHermesModelCatalog(fakeClient(modelOptionsResult)); // learn
  await readHermesModelCatalog(fakeClient(new Error("gateway gone"))); // failed fetch — must not clobber
  assert.equal(hermesProviderDisplayName("openrouter"), "OpenRouter");
  resetHermesProviderInfoCache();
});

test("labels: trivially-available capability hints appended; plain id otherwise", () => {
  const catalog = mapHermesModelOptions(modelOptionsResult);
  const fastAndReasoning = catalog.models.find((entry) => entry.id === "anthropic/claude-opus-5");
  assert.equal(fastAndReasoning.label, "anthropic/claude-opus-5 (fast, reasoning)");
  const reasoningOnly = catalog.models.find((entry) => entry.id === "deepseek-v4-pro");
  assert.equal(reasoningOnly.label, "deepseek-v4-pro (reasoning)");
  const noHints = catalog.models.find((entry) => entry.id === "stealth/union-alpha"); // fast:false, reasoning:false
  assert.equal(noHints.label, "stealth/union-alpha");
});

test("row filter: authenticated:true kept; explicit false dropped; missing flag kept only for the is_current row (fail-open)", () => {
  const catalog = mapHermesModelOptions({
    providers: [
      { slug: "a", models: ["m1"], authenticated: true },
      { slug: "b", models: ["m2"], authenticated: false },
      { slug: "c", models: ["m3"] }, // flag missing, not current → dropped
      { slug: "d", models: ["m4"], is_current: true }, // flag missing, current → kept (fail-open)
      { slug: "e", models: ["m5"], is_current: true, authenticated: false }, // explicit false beats current
      { slug: "f", models: ["m6"], is_current: true, authenticated: true },
    ],
    model: "m4",
    provider: "d",
  });
  assert.deepEqual(catalog.models.map((entry) => entry.id), ["m1", "m4", "m6"]);
  assert.equal(catalog.provider, "d");
  assert.equal(catalog.defaultModel, "m4");
});

test("fail-soft mapping: garbage top-level shapes map to the empty catalog, never throw", () => {
  for (const bad of [null, undefined, 42, "x", [], [{}], true, { providers: 3 }]) {
    const catalog = mapHermesModelOptions(bad);
    assert.equal(catalog.provider, "Hermes");
    assert.deepEqual(catalog.models, []);
    assert.equal(catalog.defaultModel, undefined);
  }
});

test("fail-soft rows: malformed rows/entries are dropped, salvageable ones survive", () => {
  const catalog = mapHermesModelOptions({
    providers: [
      null,
      42,
      "row",
      { slug: "" }, // empty slug → dropped
      { slug: "g", models: "nope", authenticated: true }, // models not an array → dropped
      { slug: "h", models: [null, 42, "", "ok"], authenticated: true }, // bad ids skipped, good kept
      { slug: 7, models: ["no"], authenticated: true }, // slug not a string → dropped
    ],
    model: 42, // non-string default → undefined
    provider: "", // empty provider → "Hermes"
  });
  assert.deepEqual(catalog.models.map((entry) => entry.id), ["ok"]);
  assert.equal(catalog.models[0].provider, "h");
  assert.equal(catalog.defaultModel, undefined);
  assert.equal(catalog.provider, "Hermes");
});

test("top-level default/provider taken verbatim (no trim); missing/garbage fall back", () => {
  const verbatim = mapHermesModelOptions({ providers: [], model: " m ", provider: "p1" });
  assert.equal(verbatim.defaultModel, " m ");
  assert.equal(verbatim.provider, "p1");
  const missing = mapHermesModelOptions({ providers: [] });
  assert.equal(missing.defaultModel, undefined);
  assert.equal(missing.provider, "Hermes");
});

test("no client (and no fresh cache) → the empty placeholder-skip catalog; never throws", async () => {
  resetHermesModelCatalogCache();
  const catalog = await readHermesModelCatalog();
  assert.equal(catalog.provider, "Hermes");
  assert.deepEqual(catalog.models, []);
  assert.equal(catalog.defaultModel, undefined); // the Task 7 skip signal (占位禁外流)
});

test("failing RPC resolves to the empty catalog (never throws) and is NOT cached", async () => {
  resetHermesModelCatalogCache();
  const empty = await readHermesModelCatalog(fakeClient(new Error("gateway gone")));
  assert.deepEqual(empty.models, []);
  assert.equal(empty.defaultModel, undefined);
  // the failure left nothing behind: a good client populates without a reset
  const catalog = await readHermesModelCatalog(fakeClient(modelOptionsResult));
  assert.ok(catalog.models.length > 0);
  assert.equal(catalog.defaultModel, "deepseek-v4-pro");
});

test("a resolved-but-garbage response is NOT cached (the next call retries)", async () => {
  resetHermesModelCatalogCache();
  const garbage = await readHermesModelCatalog(fakeClient("garbage"));
  assert.deepEqual(garbage.models, []);
  const catalog = await readHermesModelCatalog(fakeClient(modelOptionsResult));
  assert.equal(catalog.models.length, expectedFixtureCount());
});

test("cache: within the TTL, repeat calls hit the in-process cache even across client instances (single-world)", async () => {
  resetHermesModelCatalogCache();
  const first = await readHermesModelCatalog(fakeClient(modelOptionsResult));
  const second = await readHermesModelCatalog(fakeClient(modelOptionsResult)); // different instance, zero calls
  assert.equal(second, first); // same cached object — the cache is keyed on nothing
  // reset hook (the codex setCodexFactory-style test seam) drops it
  resetHermesModelCatalogCache();
  const third = await readHermesModelCatalog(fakeClient(modelOptionsResult));
  assert.notEqual(third, first);
  assert.equal(third.defaultModel, "deepseek-v4-pro");
});

test("cache: ttlMs 0 bypasses both the read and the write", async () => {
  resetHermesModelCatalogCache();
  const seeder = fakeClient(modelOptionsResult);
  await readHermesModelCatalog(seeder); // default TTL — populates the cache
  assert.equal(seeder.calls, 1);
  const fresh = fakeClient(modelOptionsResult);
  await readHermesModelCatalog(fresh, { ttlMs: 0 }); // read bypassed
  assert.equal(fresh.calls, 1);
  await readHermesModelCatalog(fresh, { ttlMs: 0 }); // write bypassed too
  assert.equal(fresh.calls, 2);
});

test("cache: past the default 5-min TTL the next call re-fetches", async (t) => {
  resetHermesModelCatalogCache();
  t.mock.timers.enable({ now: 1_000_000 });
  try {
    const seeded = await readHermesModelCatalog(fakeClient(modelOptionsResult));
    assert.ok(seeded.models.length > 0);
    t.mock.timers.tick(5 * 60_000 + 1); // past HERMES_MODEL_CATALOG_DEFAULT_TTL_MS
    const refetched = await readHermesModelCatalog(fakeClient(modelOptionsResult));
    assert.notEqual(refetched, seeded); // stale entry ignored → fresh object
    assert.equal(refetched.defaultModel, "deepseek-v4-pro");
  } finally {
    t.mock.timers.reset();
  }
});

test("probe pattern: a fresh cached catalog is served even to client-less calls (probe client may close after fetch)", async () => {
  resetHermesModelCatalogCache();
  const populated = await readHermesModelCatalog(fakeClient(modelOptionsResult)); // probe → fetch → close
  const later = await readHermesModelCatalog(); // probe long gone, no client
  assert.equal(later, populated);
});

test("single-flight: concurrent calls share one fetch (no duplicate RPC)", async () => {
  resetHermesModelCatalogCache();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const slow = {
    modelOptions() {
      calls += 1;
      return gate.then(() => modelOptionsResult);
    },
  };
  const first = readHermesModelCatalog(slow);
  const second = readHermesModelCatalog(slow);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(a, b);
});

test("dedupe (r4): cross-provider duplicate ids collapse — current row wins, others drop, order preserved", () => {
  const catalog = mapHermesModelOptions({
    providers: [
      { slug: "a", models: ["m1", "shared"], authenticated: true },
      { slug: "b", models: ["shared", "m2"], authenticated: true, is_current: true },
      { slug: "c", models: ["shared", "m3"], authenticated: true },
    ],
    model: "shared",
    provider: "b",
  });
  // "shared" collapses onto ONE entry — the is_current row (b) wins over a and c
  assert.deepEqual(catalog.models.map((e) => e.id), ["m1", "shared", "m2", "m3"]);
  assert.equal(catalog.models.find((e) => e.id === "shared").provider, "b");
  // non-duplicates keep their relative order (m1 before m2 before m3)
  assert.deepEqual(catalog.models.filter((e) => e.id !== "shared").map((e) => e.id), ["m1", "m2", "m3"]);
  // no duplicate ids remain
  const ids = catalog.models.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("dedupe (r4): first authenticated row wins when no current row collides (gateway order)", () => {
  const catalog = mapHermesModelOptions({
    providers: [
      { slug: "first", models: ["dup"], authenticated: true },
      { slug: "second", models: ["dup", "other"], authenticated: true },
    ],
    model: "dup",
    provider: "first",
  });
  assert.deepEqual(catalog.models.map((e) => e.id), ["dup", "other"]);
  assert.equal(catalog.models.find((e) => e.id === "dup").provider, "first");
});
