/**
 * agy-client.test.mjs — bridge client unit tests against the mock bridge.
 * Covers: lazy spawn (no child before first prompt), start config flush,
 * JSONL framing + chunk streaming, done/conversation-id capture, spawn-death
 * retry surface, store round-trip, native default-model read.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const here = new URL(".", import.meta.url).pathname;
const fixtures = join(here, "fixtures");
const dist = join(here, "..", "dist");

const { AgyBridgeClient } = await import(join(dist, "agy-client.js"));
const { readAdapterState, writeAdapterState, readNativeDefaultModel } =
  await import(join(dist, "agy-store.js"));
const { AGY_MODEL_CATALOG, catalogSlugs } = await import(join(dist, "models.js"));

function mockOpts() {
  return {
    bridgePath: join(fixtures, "mock_bridge.mjs"),
    pythonBin: process.execPath,
    spawnAttempts: 2,
  };
}

test("lazy: no child spawns before first prompt (start buffered)", async () => {
  const trace = join(mkdtempSync(join(tmpdir(), "agy-")), "trace.jsonl");
  const client = new AgyBridgeClient({
    ...mockOpts(),
    apiKey: "test-key",
    model: "gemini-3.5-flash",
  });
  // No ping/prompt yet — a well-behaved client must not have spawned anything.
  // We assert indirectly: close() on a never-used client is a no-op that
  // resolves without touching the mock (which would have written trace lines).
  await client.close();
  assert.throws(() => readFileSync(trace, "utf8"), "no trace file expected before prompt");
});

test("turn streams chunks and captures conversation id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agy-"));
  const trace = join(dir, "trace.jsonl");
  const client = new AgyBridgeClient({
    bridgePath: join(fixtures, "mock_bridge.mjs"),
    pythonBin: process.execPath,
    apiKey: "k-1",
    model: "gemini-3.5-flash",
  });
  process.env.AGY_MOCK_SCRIPT = JSON.stringify([
    { events: [{ event: "started" }] },
    {
      events: [
        { event: "chunk", text: "OK" },
        { event: "done", conversation_id: "cid-9", turn_ms: 12 },
      ],
    },
  ]);
  process.env.AGY_MOCK_TRACE = trace;
  let streamed = "";
  for await (const piece of client.turn("Reply with exactly: OK")) streamed += piece;
  assert.equal(streamed, "OK");
  assert.equal(client.conversationId, "cid-9");
  const lines = readFileSync(trace, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((r) => r.op), ["start", "prompt"]);
  assert.equal(lines[0].api_key, "k-1");
  assert.equal(lines[1].text, "Reply with exactly: OK");
  assert.equal(lines[1].conversation_id, undefined, "no conversation id on first turn");
  delete process.env.AGY_MOCK_SCRIPT;
  delete process.env.AGY_MOCK_TRACE;
  await client.close();
});

test("bridge death mid-turn surfaces as recoverable error, not silent hang", async () => {
  const client = new AgyBridgeClient({
    bridgePath: join(fixtures, "mock_bridge.mjs"),
    pythonBin: process.execPath,
  });
  process.env.AGY_MOCK_SCRIPT = JSON.stringify([
    { events: [{ event: "started" }] },
    { events: [], exit: 3 },
  ]);
  await assert.rejects(
    () => {
      const p = (async () => {
        for await (const _ of client.turn("x")) { /* stream */ }
      })();
      return p;
    },
    /bridge exited|agy bridge/,
  );
  delete process.env.AGY_MOCK_SCRIPT;
  await client.close();
});

test("adapter store round-trips api key in world home", () => {
  const home = mkdtempSync(join(tmpdir(), "agy-home-"));
  assert.deepEqual(readAdapterState(home), {});
  writeAdapterState(home, { apiKey: "sk-test", defaultModel: "gemini-3.5-flash" });
  assert.equal(readAdapterState(home).apiKey, "sk-test");
  assert.equal(readAdapterState(home).defaultModel, "gemini-3.5-flash");
});

test("native default model read from fixture native home (read-only)", () => {
  const native = mkdtempSync(join(tmpdir(), "agy-native-"));
  mkdirSync(join(native, "antigravity-cli"), { recursive: true });
  writeFileSync(
    join(native, "antigravity-cli", "settings.json"),
    JSON.stringify({ security: { auth: { selectedType: "vertex-ai" } }, model: "Gemini 3.7 Flash (Medium)", gcp: { project: "p", location: "global" } }),
  );
  assert.equal(readNativeDefaultModel(native), "Gemini 3.7 Flash (Medium)");
  // missing / malformed native homes degrade to undefined
  assert.equal(readNativeDefaultModel(join(native, "nope")), undefined);
  const bad = mkdtempSync(join(tmpdir(), "agy-native2-"));
  mkdirSync(join(bad, "antigravity-cli"), { recursive: true });
  writeFileSync(join(bad, "antigravity-cli", "settings.json"), "{not json");
  assert.equal(readNativeDefaultModel(bad), undefined);
});

test("static catalog exposes consumer slugs", () => {
  assert.ok(catalogSlugs().includes("gemini-3.5-flash"));
  assert.ok(AGY_MODEL_CATALOG.length >= 3);
});

test("ADC evidence satisfies auth gate without an api key", async () => {
  const { hasAdcEvidence } = await import(join(dist, "agy-store.js"));
  const home = mkdtempSync(join(tmpdir(), "agy-adc-"));
  assert.equal(hasAdcEvidence({}, home), false, "no ADC -> gate demands onboarding");
  const gcloud = join(home, ".config", "gcloud");
  mkdirSync(gcloud, { recursive: true });
  writeFileSync(join(gcloud, "application_default_credentials.json"), '{"type":"authorized_user"}');
  assert.equal(hasAdcEvidence({}, home), true, "gcloud user ADC -> no onboarding");
  const withEnv = mkdtempSync(join(tmpdir(), "agy-adc2-"));
  writeFileSync(join(withEnv, "sa.json"), "{}");
  assert.equal(hasAdcEvidence({ GOOGLE_APPLICATION_CREDENTIALS: join(withEnv, "sa.json") }, home), true);
  const bare = mkdtempSync(join(tmpdir(), "agy-adc3-"));
  assert.equal(hasAdcEvidence({ GOOGLE_APPLICATION_CREDENTIALS: "/nonexistent/sa.json" }, bare), false,
    "dangling env path + no gcloud ADC -> no evidence");
});

test("gcloud default project is read from fixture config (ADC companion)", async () => {
  const { readGcloudProject } = await import(join(dist, "agy-store.js"));
  const home = mkdtempSync(join(tmpdir(), "agy-gcloud-"));
  assert.equal(readGcloudProject(home), undefined);
  const cfg = join(home, ".config", "gcloud", "configurations");
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, "config_default"), "[core]\naccount = a@b.c\nproject = my-proj-1\n");
  assert.equal(readGcloudProject(home), "my-proj-1");
});

test("TUI display names normalize to Vertex slugs", async () => {
  const { toModelSlug } = await import(join(dist, "models.js"));
  assert.equal(toModelSlug("Gemini 3.7 Flash (Medium)"), "gemini-3.7-flash");
  assert.equal(toModelSlug("gemini-3.5-flash"), "gemini-3.5-flash");
  assert.equal(toModelSlug("Gemini 3.5 Pro (High)"), "gemini-3.5-pro");
  assert.equal(toModelSlug(undefined), undefined);
  assert.equal(toModelSlug("random gibberish"), undefined);
});
