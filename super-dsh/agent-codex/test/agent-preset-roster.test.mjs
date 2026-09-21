#!/usr/bin/env node
/**
 * SingleCodexPresetRoster — the one "Codex" mode the dsh Web UI's agent-preset
 * surfaces render. Covers the P1 contract (omp test port):
 *
 *   - `list` returns exactly one row (id "codex", trust "system", isDefault
 *     true, name "Codex") plus `authorable: false`, so the hero chip and the
 *     session header label resolve the single mode instead of rendering
 *     nothing.
 *   - The rejection methods (`copy`, `deletePreset`) fail as `RemoteError`s
 *     with the stable `agent-preset/read-only` code and typed details, so the
 *     UI surfaces refuse gracefully rather than crashing.
 *   - The service registers under the `agentPresets` namespace, which is how
 *     the browser's `ctx.remote.agentPresets.*` resolves.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { Context } from "@deepseek-ai/cordis";
import { remoteMethods } from "@deepseek-ai/dsh-typert-protocol";

const { SingleCodexPresetRoster } = await import("../dist/agent-preset-codex.js");

function makeRoster() {
  return new SingleCodexPresetRoster(new Context());
}

test("registers under the agentPresets namespace for ctx.remote.agentPresets", () => {
  const roster = makeRoster();
  assert.equal(roster.name, "agentPresets");
  assert.equal(roster.typertRemote.namespace, "agentPresets");
  assert.equal(roster.typertRemote.serviceKey, "agentPresets");
  // The endpoints the browser's generated `agentPresets.*` face calls.
  const methods = remoteMethods(roster).map((m) => m.exportName ?? m.method);
  assert.deepEqual(methods, ["list", "read", "copy", "deletePreset", "select"]);
});

test("list returns exactly one Codex row marked default, not authorable", async () => {
  const roster = makeRoster();
  const result = await roster.remoteList();
  assert.equal(result.authorable, false);
  assert.equal(result.presets.length, 1);
  assert.deepEqual(result.presets[0], {
    id: "codex",
    trust: "system",
    isDefault: true,
    name: "Codex",
    description: "Codex agent via the agent-codex adapter",
  });
});

test("copy is refused as a read-only RemoteError with typed details", async () => {
  const roster = makeRoster();
  await assert.rejects(
    () => roster.remoteCopy("codex", "fork"),
    (error) => {
      assert.equal(error.code, "agent-preset/read-only");
      assert.equal(error.isDSHRemoteError, true);
      assert.equal(error.details.agentPreset, "fork");
      assert.equal(typeof error.details.reason, "string");
      return true;
    },
  );
});

test("delete is refused as a read-only RemoteError with typed details", async () => {
  const roster = makeRoster();
  await assert.rejects(
    () => roster.remoteDelete("codex"),
    (error) => {
      assert.equal(error.code, "agent-preset/read-only");
      assert.equal(error.isDSHRemoteError, true);
      assert.equal(error.details.agentPreset, "codex");
      assert.equal(typeof error.details.reason, "string");
      return true;
    },
  );
});

test("read serves the Codex document and refuses an unknown id as not-found", async () => {
  const roster = makeRoster();
  const doc = await roster.remoteRead("codex");
  assert.equal(doc.agentPreset, "codex");
  assert.equal(doc.trust, "system");
  assert.equal(doc.name, "Codex");
  assert.equal(doc.description, "Codex agent via the agent-codex adapter");
  assert.equal(typeof doc.content, "string");

  await assert.rejects(
    () => roster.remoteRead("nope"),
    (error) => error.code === "agent-preset/not-found",
  );
});

test("select acks the single preset and refuses an unknown id as not-found", async () => {
  const roster = makeRoster();
  assert.equal(await roster.remoteSelect({}, "codex"), "codex");
  await assert.rejects(
    () => roster.remoteSelect({}, "nope"),
    (error) => error.code === "agent-preset/not-found",
  );
});

test("projection defaults every session to codex and folds selection events", async () => {
  const { codexAgentPresetProjection } = await import("../dist/agent-preset-projection.js");
  assert.equal(codexAgentPresetProjection.key, "agentPreset");
  assert.equal(codexAgentPresetProjection.init({}, 0), "codex");
  assert.equal(codexAgentPresetProjection.init({ agentPreset: "codex" }, 0), "codex");
  const next = codexAgentPresetProjection.apply(null, { type: "agent-preset/selected", data: { agentPreset: "codex" } });
  assert.equal(next, "codex");
  assert.equal(codexAgentPresetProjection.apply("codex", { type: "turn/start", data: {} }), "codex", "unrelated events keep the reference");
  assert.deepEqual(codexAgentPresetProjection.wire.view("codex"), "codex");
});
