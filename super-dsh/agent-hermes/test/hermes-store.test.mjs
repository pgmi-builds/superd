// Task 4 TDD (RED first): src/hermes-store.ts — the DSH-session ↔ Hermes-gateway-session
// identity map ("mapping only" model): round-trip, null = "not yet materialized"
// (first prompt pending), merge semantics, atomic write (temp+rename, mode 0600),
// malformed-JSON fail-soft, forget idempotency, and <DSH_HOME>/agents/hermes
// resolution (explicit home first, $DSH_HOME env fallback, cwd test-home default).
// Tests use only tmpdir homes — never the real ~/.hermes and never the repo .tests.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const {
  resolveHermesAppDir,
  sessionMapPath,
  readSessionMap,
  sessionRecord,
  upsertSession,
  forgetSession,
} = await import("../dist/hermes-store.js");

function tempHome() {
  return mkdtempSync(join(tmpdir(), "aw-hermes-map-"));
}

test("resolveHermesAppDir: explicit DSH-root home nests agents/hermes (Form-A)", () => {
  const home = tempHome();
  const appDir = resolveHermesAppDir(home);
  assert.equal(appDir, join(home, "agents", "hermes"));
  assert.equal(sessionMapPath(home), join(appDir, "dsh-sessions.json"));
});

test("resolveHermesAppDir: an already-nested <root>/agents/hermes home passes through unchanged (Form-B)", () => {
  const home = tempHome();
  const worldHome = join(home, "agents", "hermes");
  assert.equal(resolveHermesAppDir(worldHome), worldHome);
  assert.equal(sessionMapPath(worldHome), join(worldHome, "dsh-sessions.json"));
});

test("resolveHermesAppDir: $DSH_HOME env fallback when no home is passed", () => {
  const envHome = tempHome();
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = envHome;
  try {
    assert.equal(resolveHermesAppDir(), join(envHome, "agents", "hermes"));
    assert.equal(sessionMapPath(), join(envHome, "agents", "hermes", "dsh-sessions.json"));
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});

test("resolveHermesAppDir: last-resort default is <cwd>/.tests/aw", () => {
  const previous = process.env.DSH_HOME;
  delete process.env.DSH_HOME;
  try {
    assert.equal(resolveHermesAppDir(), join(process.cwd(), ".tests", "aw", "agents", "hermes"));
  } finally {
    if (previous !== undefined) process.env.DSH_HOME = previous;
  }
});

test("resolveHermesAppDir: prod homes are refused", () => {
  assert.throws(() => resolveHermesAppDir(join(homedir(), ".dsh")));
  assert.throws(() => resolveHermesAppDir(join(homedir(), ".superd")));
});

test("upsertSession round-trips a record through the map file", () => {
  const home = tempHome();
  const path = sessionMapPath(home);

  upsertSession(home, "session-1", {
    gatewaySessionId: null,
    cwd: "/tmp/base",
    createdAt: 111,
    preset: "danger-full-access",
  });
  const record = sessionRecord(home, "session-1");
  assert.deepEqual(record, {
    gatewaySessionId: null,
    gatewayStoredSessionId: null,
    cwd: "/tmp/base",
    createdAt: 111,
    preset: "danger-full-access",
  });
  // persisted on disk as JSON, keyed by the DSH session id
  const raw = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(Object.keys(raw), ["session-1"]);
  assert.equal(raw["session-1"].cwd, "/tmp/base");
});

test("gatewaySessionId: null means not yet materialized — the observation fills it in and keeps every other field", () => {
  const home = tempHome();
  // create: first prompt pending → gatewaySessionId explicitly null
  upsertSession(home, "session-2", { gatewaySessionId: null, gatewayStoredSessionId: null, cwd: "/tmp/awk", createdAt: 222, preset: null });
  assert.equal(sessionRecord(home, "session-2").gatewaySessionId, null);
  // observe: the gateway session id materializes after the first prompt
  const observed = upsertSession(home, "session-2", { gatewaySessionId: "gw-sess-42", gatewayStoredSessionId: "stored-42" });
  assert.deepEqual(observed, {
    gatewaySessionId: "gw-sess-42",
    gatewayStoredSessionId: "stored-42",
    cwd: "/tmp/awk",
    createdAt: 222,
    preset: null,
  });
  assert.deepEqual(sessionRecord(home, "session-2"), observed);
});

test("merge semantics: omitted patch fields keep stored values; defaults fill a fresh record", () => {
  const home = tempHome();
  // fresh record: cwd/createdAt/preset default
  const fresh = upsertSession(home, "session-fresh", {});
  assert.deepEqual(fresh, { gatewaySessionId: null, gatewayStoredSessionId: null, cwd: "", createdAt: fresh.createdAt, preset: null });
  assert.ok(Number.isFinite(fresh.createdAt) && fresh.createdAt > 0);

  // partial patch merges over the stored record
  upsertSession(home, "session-merge", { gatewaySessionId: null, gatewayStoredSessionId: null, cwd: "/tmp/m", createdAt: 7, preset: "p" });
  upsertSession(home, "session-merge", { cwd: "/tmp/m2" });
  assert.deepEqual(sessionRecord(home, "session-merge"), {
    gatewaySessionId: null,
    gatewayStoredSessionId: null,
    cwd: "/tmp/m2",
    createdAt: 7,
    preset: "p",
  });
});

test("readSessionMap is empty for a missing file and for malformed JSON", () => {
  const home = tempHome();
  assert.deepEqual(readSessionMap(home), {});

  const path = sessionMapPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "{ this is not json");
  assert.deepEqual(readSessionMap(home), {});
  assert.equal(sessionRecord(home, "session-3"), undefined);

  // an upsert over a corrupt map starts from empty instead of throwing
  upsertSession(home, "session-3", { gatewaySessionId: null, cwd: "/tmp/x", createdAt: 333, preset: null });
  assert.equal(sessionRecord(home, "session-3").cwd, "/tmp/x");
});

test("malformed ENTRIES are dropped, valid ones survive (fail-soft read)", () => {
  const home = tempHome();
  const path = sessionMapPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      "session-good": { gatewaySessionId: "gw1", cwd: "/tmp/good", createdAt: 1, preset: null },
      "session-bad": { gatewaySessionId: "gw2", createdAt: 2 },
      "session-worse": 42,
    }),
  );
  const map = readSessionMap(home);
  assert.deepEqual(Object.keys(map), ["session-good"]);
  assert.equal(map["session-good"].gatewaySessionId, "gw1");
});

test("writes are atomic: no temp residue, mode 0600, valid JSON after many upserts", () => {
  const home = tempHome();
  for (let i = 0; i < 5; i += 1) {
    upsertSession(home, `session-${i}`, {
      gatewaySessionId: i % 2 === 0 ? null : `gw-${i}`,
      cwd: `/tmp/w${i}`,
      createdAt: i,
      preset: null,
    });
  }
  // explicit DSH-root home nests agents/hermes, so the map lands at
  // <home>/agents/hermes/dsh-sessions.json
  assert.deepEqual(readdirSync(home), ["agents"]);
  assert.deepEqual(readdirSync(join(home, "agents", "hermes")), ["dsh-sessions.json"]);
  const path = sessionMapPath(home);
  const mode = statSync(path).mode & 0o777;
  assert.equal(mode, 0o600);
  const map = readSessionMap(home);
  assert.equal(Object.keys(map).length, 5);
  assert.equal(map["session-3"].gatewaySessionId, "gw-3");
  assert.equal(map["session-4"].gatewaySessionId, null);
});

test("forgetSession drops one record, idempotently", () => {
  const home = tempHome();
  upsertSession(home, "session-keep", { gatewaySessionId: "gw-k", cwd: "/tmp/k", createdAt: 1, preset: null });
  upsertSession(home, "session-drop", { gatewaySessionId: null, cwd: "/tmp/d", createdAt: 2, preset: null });
  forgetSession(home, "session-drop");
  assert.equal(sessionRecord(home, "session-drop"), undefined);
  assert.equal(sessionRecord(home, "session-keep").cwd, "/tmp/k");
  forgetSession(home, "session-drop"); // idempotent
  forgetSession(home, "never-existed");
  assert.deepEqual(Object.keys(readSessionMap(home)), ["session-keep"]);
});

test("gatewayStoredSessionId: durable key coerces (non-empty string else null) and merges like the other fields", () => {
  const home = tempHome();
  // malformed stored id in the JSON → null (fail-soft coerce)
  const path = sessionMapPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      "session-c": { gatewaySessionId: "live1", gatewayStoredSessionId: 42, cwd: "/tmp/c", createdAt: 1, preset: null },
      "session-d": { gatewaySessionId: "live2", gatewayStoredSessionId: "", cwd: "/tmp/d", createdAt: 2, preset: null },
    }),
  );
  assert.equal(readSessionMap(home)["session-c"].gatewayStoredSessionId, null);
  assert.equal(readSessionMap(home)["session-d"].gatewayStoredSessionId, null);

  // materialize: live id remints, durable id captured — both stored, merge preserves cwd/preset
  const rec = upsertSession(home, "session-e", {
    gatewaySessionId: null,
    gatewayStoredSessionId: null,
    cwd: "/tmp/e",
    createdAt: 3,
    preset: "workspace-write",
  });
  assert.deepEqual(rec, {
    gatewaySessionId: null,
    gatewayStoredSessionId: null,
    cwd: "/tmp/e",
    createdAt: 3,
    preset: "workspace-write",
  });
  const materialized = upsertSession(home, "session-e", { gatewaySessionId: "live-new", gatewayStoredSessionId: "20260917_084602_389e64" });
  assert.equal(materialized.gatewaySessionId, "live-new");
  assert.equal(materialized.gatewayStoredSessionId, "20260917_084602_389e64");
  assert.equal(materialized.cwd, "/tmp/e", "other fields preserved across the durable-id capture");
});
