/**
 * preset-projection.test.mjs — SingleAgyPresetRoster + agentPreset projection.
 * Covers: roster defaultId, projection init/selected advance, and the
 * skipPermissions → spawn argv mapping (mock agy binary captures argv).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Context } from "@deepseek-ai/cordis";

const here = new URL(".", import.meta.url).pathname;
const dist = join(here, "..", "dist");
const fixtures = join(here, "fixtures");

const { SingleAgyPresetRoster } = await import(join(dist, "agent-preset-agy.js"));
const { agyAgentPresetProjection } = await import(join(dist, "agent-preset-projection.js"));
const { AgyCliClient } = await import(join(dist, "agy-cli-client.js"));

function rosterCtx() {
  return new Context();
}

test("roster: single fixed preset 'agy', defaultId matches, authorable false", async () => {
  const roster = new SingleAgyPresetRoster(rosterCtx());
  assert.equal(roster.defaultId, "agy");
  assert.equal(roster.authorable, false);
  const presets = await roster.list();
  assert.equal(presets.length, 1);
  assert.equal(presets[0].id, "agy");
  assert.equal(presets[0].name, "Antigravity");
  const content = await roster.read("agy");
  assert.match(content, /rows: \[\]/);
  await assert.rejects(() => roster.resolve("other"), /not found/);
});

test("projection: init defaults to 'agy' and advances on agent-preset/selected", () => {
  const init = agyAgentPresetProjection.init({});
  assert.equal(init, "agy");
  let state = agyAgentPresetProjection.init({ agentPreset: "agy" });
  state = agyAgentPresetProjection.apply(state, { type: "agent-preset/selected", data: { agentPreset: "agy" } });
  assert.equal(state, "agy");
  // unrelated events leave state untouched
  state = agyAgentPresetProjection.apply(state, { type: "turn/start", data: {} });
  assert.equal(state, "agy");
});

test("skipPermissions maps danger-full-access to --dangerously-skip-permissions in argv", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agy-argv-"));
  const trace = join(dir, "argv.jsonl");
  const nativeHome = mkdtempSync(join(tmpdir(), "agy-home-"));
  const client = new AgyCliClient({
    apiKey: "k-test",
    cwd: "/tmp",
    agyBin: join(fixtures, "mock_agy_bin.sh"),
    nativeCliHome: nativeHome,
    skipPermissions: true,
    trace: () => { },
  });
  // swap spawn args capture: the mock writes argv from process.argv
  process.env.AGY_MOCK_TRACE = trace;
  process.env.AGY_MOCK_SCRIPT = JSON.stringify([
    { lines: [{ event: "init", conversation_id: "c1", init: { tools: ["t"], permission_mode: "request-review" } }] },
    { lines: [{ event: "step_update", step_update: { step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "hi" } }] },
    { lines: [{ event: "result", result: { conversation_id: "c1", status: "SUCCESS", response: "hi" } }] },
  ]);
  // mock needs the fixtures' script env — the mock reads AGY_MOCK_SCRIPT itself
  let full = "";
  for await (const piece of client.turn("hi")) full += piece;
  assert.equal(full, "hi");
  const argvLines = readFileSync(trace, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const argv = argvLines[0].argv;
  assert.ok(argv.includes("--dangerously-skip-permissions"), `argv includes skip flag: ${JSON.stringify(argv)}`);
  assert.ok(argv.some((a) => a.startsWith("--input-format=stream-json")), "stream-json input present");
  assert.equal(argv.includes("--print"), false, "--print must not appear (value-flag collision)");
  delete process.env.AGY_MOCK_TRACE;
  delete process.env.AGY_MOCK_SCRIPT;
  await client.close();
});
