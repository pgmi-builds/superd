// Task 1 spike gate: real streamed turn under the isolated nested CODEX_HOME
// + turn-level AbortSignal verification + fixture capture for Task 2.
// Skips (loudly) when the nested home has not been provisioned by
// scripts/setup-codex-home.mjs — provisioning needs real-filesystem access.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runSpike } from "../dist/spike.js";

/** Repository root: walk up until the upstream checkout is a sibling (works
 *  identically from the worktree and the main checkout). */
function repoRoot(start) {
  let dir = start;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, "upstream", "deepseek-harness", "package.json"))) return dir;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`repo root not found above ${start}`);
}


const WT = repoRoot(join(new URL(".", import.meta.url).pathname, ".."));
const HOME = process.env.DSH_HOME ?? join(WT, ".tests");
const CODEX_HOME = process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(HOME, ".codex");
const PROVISIONED = existsSync(join(CODEX_HOME, "auth.json"));
const CWD = join(new URL("..", import.meta.url).pathname);

test("spike: real streamed turn via @openai/codex-sdk under isolated CODEX_HOME", { skip: !PROVISIONED && `provision first: node scripts/setup-codex-home.mjs (no auth.json under ${CODEX_HOME})` }, async () => {
  const result = await runSpike({ codexHome: CODEX_HOME, cwd: CWD });
  assert.ok(result.threadId, "thread id populated after first turn");
  assert.match(result.finalResponse, /ok/i, "final response echoes the prompt contract");
  assert.ok(result.usage, "turn.completed carries usage");
  // Fixture capture for Task 2 (own synthetic turn only — no user transcripts).
  // Guarded: a live capture that opens with a provider/item error (e.g. a model
  // whose catalog metadata is missing) is NOT a canonical chain, and rewriting
  // the shared fixture with it would break the offline projection tests. Keep
  // the committed sample in that case; the live assertion above still reports.
  const captured = result.events;
  const canonical =
    Array.isArray(captured) &&
    captured[1]?.type === "turn.started" &&
    captured.some((event) => event?.type === "turn.completed") &&
    !captured.some((event) => event?.item?.type === "error");
  if (canonical) {
    mkdirSync(join(new URL("..", import.meta.url).pathname, "test", "fixtures"), { recursive: true });
    writeFileSync(
      join(new URL(".", import.meta.url).pathname, "fixtures", "thread-events.sample.json"),
      JSON.stringify({ threadId: result.threadId, events: captured }, null, 2),
    );
  } else {
    console.error("[spike] non-canonical capture (error item / no turn.started second) — fixture left untouched");
  }
});

test("spike: turn-level AbortSignal terminates the stream", { skip: !PROVISIONED && "not provisioned" }, async () => {
  const { Codex } = await import("@openai/codex-sdk");
  const codex = new Codex({ env: { ...process.env, CODEX_HOME } });
  const thread = codex.startThread({
    workingDirectory: CWD,
    skipGitRepoCheck: true,
    approvalPolicy: "never",
    sandboxMode: "read-only",
  });
  const controller = new AbortController();
  const streamed = await thread.runStreamed("Count slowly from 1 to 50, one number per line.", { signal: controller.signal });
  const seen = [];
  let ended = "exhausted";
  try {
    for await (const evt of streamed.events) {
      seen.push(evt.type);
      if (seen.length === 2) controller.abort();
    }
  } catch (error) {
    ended = `threw:${String(error?.name ?? error)}`;
  }
  // the abort fires after the 2nd event (thread.started + turn.started):
  // the turn must NOT run to completion behind our back.
  assert.ok(!seen.includes("turn.completed"), `turn completed despite abort (events: ${seen.join(",")}; ended via ${ended})`);
  assert.ok(seen.length < 20, `stream terminated early (saw ${seen.length} events, ended via ${ended})`);
});
