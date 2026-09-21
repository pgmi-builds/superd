// src/session-map.ts — the DSH-session ↔ pi-session-file identity map
// ("mapping only", codex model): round-trip, merge semantics, atomic write,
// malformed-JSON fail-soft, and the update-on-observe transition (create
// writes sessionFile null; the client observation fills it in).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { readSessionMap, sessionRecord, upsertSession, forgetSession } = await import("../dist/session-map.js");
const { piMappingPath } = await import("../dist/pi-home.js");

function tempHome() {
  return mkdtempSync(join(tmpdir(), "aw-pi-map-"));
}

test("upsertSession round-trips a record through the map file", () => {
  const home = tempHome();
  const path = piMappingPath(home);
  assert.equal(path, join(home, "agents", "pi", "dsh-sessions.json"));

  upsertSession(home, "session-1", { sessionFile: null, cwd: "/tmp/base", createdAt: 111, preset: "danger-full-access" });
  const record = sessionRecord(home, "session-1");
  assert.deepEqual(record, { sessionFile: null, cwd: "/tmp/base", createdAt: 111, preset: "danger-full-access" });
  // persisted on disk as JSON, keyed by the DSH session id
  const raw = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(Object.keys(raw), ["session-1"]);
  assert.equal(raw["session-1"].cwd, "/tmp/base");
});

test("update-on-observe: filling in the session file keeps every other field", () => {
  const home = tempHome();
  upsertSession(home, "session-2", { sessionFile: null, cwd: "/tmp/awk", createdAt: 222, preset: null });
  const observed = upsertSession(home, "session-2", {
    sessionFile: "/home/u1/.pi/agent/sessions/--tmp-awk--/2026-09-17T00-00-00-000Z_ab12.jsonl",
  });
  assert.deepEqual(observed, {
    sessionFile: "/home/u1/.pi/agent/sessions/--tmp-awk--/2026-09-17T00-00-00-000Z_ab12.jsonl",
    cwd: "/tmp/awk",
    createdAt: 222,
    preset: null,
  });
  assert.deepEqual(sessionRecord(home, "session-2"), observed);
});

test("readSessionMap is empty for a missing file and for malformed JSON", () => {
  const home = tempHome();
  assert.deepEqual(readSessionMap(home), {});

  const path = piMappingPath(home);
  mkdirSync(join(home, "agents", "pi"), { recursive: true });
  writeFileSync(path, "{ this is not json");
  assert.deepEqual(readSessionMap(home), {});
});

test("malformed entries are dropped, valid neighbors survive", () => {
  const home = tempHome();
  mkdirSync(join(home, "agents", "pi"), { recursive: true });
  writeFileSync(
    piMappingPath(home),
    JSON.stringify({
      good: { sessionFile: "/x/y.jsonl", cwd: "/x", createdAt: 1, preset: null },
      "bad-nocwd": { sessionFile: "/x/y.jsonl", createdAt: 2 },
      "bad-type": 42,
    }),
  );
  const map = readSessionMap(home);
  assert.deepEqual(Object.keys(map), ["good"]);
  assert.equal(map["good"].sessionFile, "/x/y.jsonl");
});

test("forgetSession removes exactly one record and is idempotent", () => {
  const home = tempHome();
  upsertSession(home, "s-a", { sessionFile: null, cwd: "/a", createdAt: 1, preset: null });
  upsertSession(home, "s-b", { sessionFile: null, cwd: "/b", createdAt: 2, preset: null });
  forgetSession(home, "s-a");
  assert.equal(sessionRecord(home, "s-a"), undefined);
  assert.ok(sessionRecord(home, "s-b"));
  forgetSession(home, "s-a");
  assert.deepEqual(Object.keys(readSessionMap(home)), ["s-b"]);
});
