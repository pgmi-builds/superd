// codex-store: home resolution + the rollout-HEAD metadata reader.
// The rollout scan / replay scanner is gone (2026-09-16): the DSH session log
// is the session authority, so the store module only resolves the native home
// and recovers ONE rollout's `session_meta` head (system prompt + cwd).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { resolveCodexHome, useCodexHome, readRolloutHead, clearRolloutHeadCache } = await import("../dist/codex-store.js");

test("resolveCodexHome defaults to the native ~/.codex (never redirected)", () => {
  const previous = process.env.CODEX_HOME;
  delete process.env.CODEX_HOME;
  try {
    assert.equal(resolveCodexHome(), join(process.env.HOME ?? "/root", ".codex"));
  } finally {
    if (previous !== undefined) process.env.CODEX_HOME = previous;
  }
});

test("resolveCodexHome honors CODEX_HOME when no home is passed", () => {
  const previous = process.env.CODEX_HOME;
  const explicit = mkdtempSync(join(tmpdir(), "aw-codex-env-"));
  process.env.CODEX_HOME = explicit;
  try {
    assert.equal(resolveCodexHome(), explicit);
    assert.equal(useCodexHome(explicit), explicit);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});

test("resolveCodexHome refuses a prod home (repo red line)", () => {
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(process.env.HOME ?? "/root", ".dsh");
  try {
    assert.throws(() => resolveCodexHome(), /refusing prod home/);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
  assert.throws(() => useCodexHome(join(process.env.HOME ?? "/root", ".superd")), /refusing prod home/);
});

function rolloutFixture(threadId, meta) {
  const codexHome = mkdtempSync(join(tmpdir(), "aw-codex-store-"));
  const dir = join(codexHome, "sessions", "2026", "09", "16");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-2026-09-16T00-00-00-${threadId}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: "session_meta", payload: meta })}\n${JSON.stringify({ type: "event_msg", payload: { type: "task_started" } })}\n`);
  return { codexHome, file };
}

test("readRolloutHead recovers base_instructions and cwd from the first line", () => {
  clearRolloutHeadCache();
  const threadId = "01a0aaa1-1111-7000-8000-000000000001";
  const { codexHome } = rolloutFixture(threadId, {
    id: threadId,
    cwd: "/home/u1/workspaces/base",
    base_instructions: "You are Codex.",
    cli_version: "0.154.0",
  });
  assert.deepEqual(readRolloutHead(codexHome, threadId), {
    threadId,
    cwd: "/home/u1/workspaces/base",
    baseInstructions: "You are Codex.",
  });
});

test("readRolloutHead is memoized per thread id (the head line never changes)", () => {
  clearRolloutHeadCache();
  const threadId = "01a0aaa1-2222-7000-8000-000000000002";
  const { codexHome, file } = rolloutFixture(threadId, { id: threadId, base_instructions: "first" });
  assert.equal(readRolloutHead(codexHome, threadId).baseInstructions, "first");
  writeFileSync(file, `${JSON.stringify({ type: "session_meta", payload: { id: threadId, base_instructions: "rewritten" } })}\n`);
  assert.equal(readRolloutHead(codexHome, threadId).baseInstructions, "first");
});

test("readRolloutHead fail-softs on unknown threads, garbage heads and junk lines", () => {
  clearRolloutHeadCache();
  const codexHome = mkdtempSync(join(tmpdir(), "aw-codex-store-"));
  assert.equal(readRolloutHead(codexHome, "01a0aaa1-3333-7000-8000-000000000003"), undefined);

  const threadId = "01a0aaa1-4444-7000-8000-000000000004";
  const dir = join(codexHome, "sessions", "2026", "09", "16");
  mkdirSync(dir, { recursive: true });
  // first line is not session_meta → no head
  writeFileSync(join(dir, `rollout-x-${threadId}.jsonl`), `${JSON.stringify({ type: "event_msg" })}\n`);
  assert.equal(readRolloutHead(codexHome, threadId), undefined);

  const other = "01a0aaa1-5555-7000-8000-000000000005";
  writeFileSync(join(dir, `rollout-y-${other}.jsonl`), "not json at all\n");
  assert.equal(readRolloutHead(codexHome, other), undefined);
});
