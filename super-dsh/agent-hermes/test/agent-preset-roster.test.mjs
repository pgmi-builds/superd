#!/usr/bin/env node
/**
 * SingleHermesPresetRoster — the one "Hermes" mode the dsh Web UI's agent-preset
 * surfaces render. Covers the P1 contract (codex test port):
 *
 *   - `list` returns exactly one row (id "hermes", trust "system", isDefault
 *     true, name "Hermes") plus `authorable: false`;
 *   - The rejection methods (`copy`, `deletePreset`) fail as `RemoteError`s
 *     with the stable `agent-preset/read-only` code and typed details;
 *   - The service registers under the `agentPresets` namespace.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { Context } from "@deepseek-ai/cordis";
import { remoteMethods } from "@deepseek-ai/dsh-typert-protocol";

const { SingleHermesPresetRoster } = await import("../dist/agent-preset-hermes.js");

function makeRoster() {
  return new SingleHermesPresetRoster(new Context());
}

test("registers under the agentPresets namespace for ctx.remote.agentPresets", () => {
  const roster = makeRoster();
  assert.equal(roster.name, "agentPresets");
  assert.equal(roster.typertRemote.namespace, "agentPresets");
  assert.equal(roster.typertRemote.serviceKey, "agentPresets");
  const methods = remoteMethods(roster).map((m) => m.exportName ?? m.method);
  assert.deepEqual(methods, ["list", "read", "copy", "deletePreset", "select"]);
});

test("list returns exactly one Hermes row marked default, not authorable", async () => {
  const roster = makeRoster();
  const result = await roster.remoteList();
  assert.equal(result.authorable, false);
  assert.equal(result.presets.length, 1);
  assert.deepEqual(result.presets[0], {
    id: "hermes",
    trust: "system",
    isDefault: true,
    name: "Hermes",
    description: "Hermes agent via the agent-hermes adapter",
  });
});

test("copy is refused as a read-only RemoteError with typed details", async () => {
  const roster = makeRoster();
  await assert.rejects(
    () => roster.remoteCopy("hermes", "fork"),
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
    () => roster.remoteDelete("hermes"),
    (error) => {
      assert.equal(error.code, "agent-preset/read-only");
      assert.equal(error.isDSHRemoteError, true);
      assert.equal(error.details.agentPreset, "hermes");
      assert.equal(typeof error.details.reason, "string");
      return true;
    },
  );
});

test("read serves the Hermes document and refuses an unknown id as not-found", async () => {
  const roster = makeRoster();
  const doc = await roster.remoteRead("hermes");
  assert.equal(doc.agentPreset, "hermes");
  assert.equal(doc.trust, "system");
  assert.equal(doc.name, "Hermes");
  assert.equal(doc.description, "Hermes agent via the agent-hermes adapter");
  assert.equal(typeof doc.content, "string");

  await assert.rejects(
    () => roster.remoteRead("nope"),
    (error) => error.code === "agent-preset/not-found",
  );
});

test("select acks the single preset and refuses an unknown id as not-found", async () => {
  const roster = makeRoster();
  assert.equal(await roster.remoteSelect({}, "hermes"), "hermes");
  await assert.rejects(
    () => roster.remoteSelect({}, "nope"),
    (error) => error.code === "agent-preset/not-found",
  );
});

test("projection defaults every session to hermes and folds selection events", async () => {
  const { hermesAgentPresetProjection } = await import("../dist/agent-preset-projection.js");
  assert.equal(hermesAgentPresetProjection.key, "agentPreset");
  assert.equal(hermesAgentPresetProjection.init({}, 0), "hermes");
  assert.equal(hermesAgentPresetProjection.init({ agentPreset: "hermes" }, 0), "hermes");
  const next = hermesAgentPresetProjection.apply(null, { type: "agent-preset/selected", data: { agentPreset: "hermes" } });
  assert.equal(next, "hermes");
  assert.equal(hermesAgentPresetProjection.apply("hermes", { type: "turn/start", data: {} }), "hermes", "unrelated events keep the reference");
  assert.deepEqual(hermesAgentPresetProjection.wire.view("hermes"), "hermes");
});
