// The claude agent-preset roster (RC-5: agentPresets/list 404 was the
// hand-test finding) and the `agentPreset` session projection fold the Web UI
// gates its preset chip / header label on.
import test from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";

const { SingleClaudePresetRoster } = await import("../dist/agent-preset-claude.js");
const { claudeAgentPresetProjection } = await import("../dist/agent-preset-projection.js");

const roster = new SingleClaudePresetRoster(new Context());

test("the roster serves exactly one frozen, non-authorable system preset: claude", async () => {
  const presets = await roster.list();
  assert.equal(presets.length, 1);
  assert.deepEqual(presets[0], {
    id: "claude",
    trust: "system",
    path: "",
    name: "Claude",
    description: "Claude Code via the agent-claude adapter",
  });
  assert.equal(Object.isFrozen(presets[0]), true);
  assert.equal(roster.authorable, false);
  assert.equal(roster.defaultId, "claude");
});

test("resolve accepts the claude preset (and no id) and rejects anything else", async () => {
  assert.equal((await roster.resolve(undefined)).id, "claude");
  assert.equal((await roster.resolve("claude")).id, "claude");
  await assert.rejects(() => roster.resolve("omp"), /preset "omp" not found/);
  await assert.rejects(() => roster.resolve("pi"), /agent-preset/);
});

test("read returns the composition text for claude only", async () => {
  const text = await roster.read("claude");
  assert.match(text, /# Claude \(fixed roster\)/);
  await assert.rejects(() => roster.read("other"), /not found/);
});

test("writes fail closed: copy and deletePreset refuse on the fixed roster", async () => {
  await assert.rejects(() => roster.copy("claude", "mine"), /cannot be written/);
  await assert.rejects(() => roster.remove("claude"), /cannot be written/);
});

test("remoteList exposes the roster row with isDefault; remoteRead serves the document", async () => {
  const listed = await roster.remoteList();
  assert.deepEqual(listed.presets.map((row) => row.id), ["claude"]);
  assert.equal(listed.presets[0].isDefault, true);
  assert.equal(listed.presets[0].name, "Claude");
  assert.equal(listed.authorable, false);

  const doc = await roster.remoteRead("claude");
  assert.equal(doc.agentPreset, "claude");
  assert.equal(doc.trust, "system");
  assert.equal(doc.name, "Claude");
  assert.match(doc.content, /rows: \[\]/);
});

test("remoteSelect acks the claude preset and refuses others", async () => {
  assert.equal(await roster.remoteSelect({}, "claude"), "claude");
  await assert.rejects(() => roster.remoteSelect({}, "codex"), /not found/);
});

test("the projection folds agent-preset/selected on top of the claude default", () => {
  assert.equal(claudeAgentPresetProjection.key, "agentPreset");
  const header = { cwd: "/w", id: "session-x" };
  assert.equal(claudeAgentPresetProjection.init(header, 0), "claude", "header without a preset defaults to claude");
  assert.equal(claudeAgentPresetProjection.init({ ...header, agentPreset: "claude" }, 0), "claude");

  const selected = { type: "agent-preset/selected", seq: 1, time: 1, data: { agentPreset: "claude" } };
  const untouched = { type: "turn/start", seq: 2, time: 2, data: { turn: 1 } };
  const state = claudeAgentPresetProjection.apply("claude", selected);
  assert.equal(state, "claude");
  // An unrelated event must return the SAME state reference (zero downstream work).
  const before = { frozen: true };
  assert.equal(claudeAgentPresetProjection.apply(before, untouched), before);
  assert.deepEqual(claudeAgentPresetProjection.wire.view("claude"), "claude");
});
