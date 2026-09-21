// src/session-map.ts — the DSH-session ↔ Codex-thread identity map:
// round-trip, merge semantics, atomic write, malformed-JSON fail-soft, and
// the update-on-observe transition (create writes threadId null; the client
// observation fills it in).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { sessionMapPath, readSessionMap, sessionRecord, upsertSession, forgetSession } = await import("../dist/session-map.js");

function tempHome() {
  return mkdtempSync(join(tmpdir(), "aw-codex-map-"));
}

test("upsertSession round-trips a record through the map file", () => {
  const home = tempHome();
  const path = sessionMapPath(home);
  assert.equal(path, join(home, "dsh-sessions.json"));

  upsertSession(home, "session-1", { threadId: null, cwd: "/tmp/base", createdAt: 111, preset: "danger-full-access" });
  const record = sessionRecord(home, "session-1");
  assert.deepEqual(record, { threadId: null, cwd: "/tmp/base", createdAt: 111, preset: "danger-full-access" });
  // persisted on disk as JSON, keyed by the DSH session id
  const raw = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(Object.keys(raw), ["session-1"]);
  assert.equal(raw["session-1"].cwd, "/tmp/base");
});

test("update-on-observe: filling in the thread id keeps every other field", () => {
  const home = tempHome();
  upsertSession(home, "session-2", { threadId: null, cwd: "/tmp/awk", createdAt: 222, preset: null });
  const observed = upsertSession(home, "session-2", { threadId: "01a0a5cb-e919-7480-81ee-7dcf758aa0aa" });
  assert.deepEqual(observed, {
    threadId: "01a0a5cb-e919-7480-81ee-7dcf758aa0aa",
    cwd: "/tmp/awk",
    createdAt: 222,
    preset: null,
  });
  assert.deepEqual(sessionRecord(home, "session-2"), observed);
});

test("readSessionMap is empty for a missing file and for malformed JSON", () => {
  const home = tempHome();
  assert.deepEqual(readSessionMap(home), {});

  const path = sessionMapPath(home);
  writeFileSync(path, "{ this is not json");
  assert.deepEqual(readSessionMap(home), {});
  assert.equal(sessionRecord(home, "session-3"), undefined);

  // an upsert over a corrupt map starts from empty instead of throwing
  upsertSession(home, "session-3", { threadId: null, cwd: "/tmp/x", createdAt: 333, preset: null });
  assert.equal(sessionRecord(home, "session-3").cwd, "/tmp/x");
});

test("malformed ENTRIES are dropped, valid ones survive (fail-soft read)", () => {
  const home = tempHome();
  const path = sessionMapPath(home);
  writeFileSync(path, JSON.stringify({
    "session-good": { threadId: "t1", cwd: "/tmp/good", createdAt: 1, preset: null },
    "session-bad": { threadId: "t2", createdAt: 2 },
    "session-worse": 42,
  }));
  const map = readSessionMap(home);
  assert.deepEqual(Object.keys(map), ["session-good"]);
  assert.equal(map["session-good"].threadId, "t1");
});

test("writes are atomic: no temp residue and the file is valid JSON after many upserts", () => {
  const home = tempHome();
  for (let i = 0; i < 5; i += 1) {
    upsertSession(home, `session-${i}`, { threadId: i % 2 === 0 ? null : `t${i}`, cwd: `/tmp/w${i}`, createdAt: i, preset: null });
  }
  assert.deepEqual(readdirSync(home), ["dsh-sessions.json"]);
  const map = readSessionMap(home);
  assert.equal(Object.keys(map).length, 5);
  assert.equal(map["session-3"].threadId, "t3");
  assert.equal(map["session-4"].threadId, null);
});

test("forgetSession drops one record, idempotently", () => {
  const home = tempHome();
  upsertSession(home, "session-keep", { threadId: "t", cwd: "/tmp/k", createdAt: 1, preset: null });
  upsertSession(home, "session-drop", { threadId: null, cwd: "/tmp/d", createdAt: 2, preset: null });
  forgetSession(home, "session-drop");
  assert.equal(sessionRecord(home, "session-drop"), undefined);
  assert.equal(sessionRecord(home, "session-keep").cwd, "/tmp/k");
  forgetSession(home, "session-drop"); // idempotent
  forgetSession(home, "never-existed");
  assert.deepEqual(Object.keys(readSessionMap(home)), ["session-keep"]);
});

// X1 / RC-4: the sticky not-resumable refusal flag.
test("resumable:false round-trips, is sticky through merges, and can be explicitly cleared", () => {
  const home = tempHome();
  upsertSession(home, "session-r", { threadId: "t1", cwd: "/tmp/r", createdAt: 1, preset: null });
  assert.equal(sessionRecord(home, "session-r").resumable, undefined);

  upsertSession(home, "session-r", { resumable: false });
  assert.equal(sessionRecord(home, "session-r").resumable, false);

  // A merge that omits the flag keeps the refusal (sticky).
  upsertSession(home, "session-r", { threadId: "t2" });
  const record = sessionRecord(home, "session-r");
  assert.equal(record.resumable, false);
  assert.equal(record.threadId, "t2");

  // An explicit true clears it.
  upsertSession(home, "session-r", { resumable: true });
  assert.equal(sessionRecord(home, "session-r").resumable, true);
});

// X1: stable resume-failure codes ride the exported error class.
test("CodexResumeError carries a stable code", async () => {
  const { CodexResumeError } = await import("../dist/session-map.js");
  const error = new CodexResumeError("ROLLOUT_MISSING", "no rollout");
  assert.equal(error.code, "ROLLOUT_MISSING");
  assert.equal(error.name, "CodexResumeError");
  assert.equal(error.message, "no rollout");
  assert.ok(error instanceof Error);
});
