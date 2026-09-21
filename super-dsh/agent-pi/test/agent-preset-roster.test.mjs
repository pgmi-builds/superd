#!/usr/bin/env node
/**
 * SinglePiPresetRoster — the one "Pi" mode the dsh Web UI's agent-preset
 * surfaces render (omp/codex test port): single default row, read-only
 * rejections, agentPresets namespace registration.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { Context } from "@deepseek-ai/cordis";
import { remoteMethods } from "@deepseek-ai/dsh-typert-protocol";

const { SinglePiPresetRoster } = await import("../dist/agent-preset-pi.js");

function makeRoster() {
  return new SinglePiPresetRoster(new Context());
}

test("registers under the agentPresets namespace for ctx.remote.agentPresets", () => {
  const roster = makeRoster();
  assert.equal(roster.name, "agentPresets");
  assert.equal(roster.typertRemote.namespace, "agentPresets");
  assert.equal(roster.typertRemote.serviceKey, "agentPresets");
  const methods = remoteMethods(roster).map((m) => m.exportName ?? m.method);
  assert.deepEqual(methods, ["list", "read", "copy", "deletePreset", "select"]);
});

test("list returns exactly one Pi row marked default, not authorable", async () => {
  const roster = makeRoster();
  const result = await roster.remoteList();
  assert.equal(result.authorable, false);
  assert.equal(result.presets.length, 1);
  assert.deepEqual(result.presets[0], {
    id: "pi",
    trust: "system",
    isDefault: true,
    name: "Pi",
    description: "Pi agent via the agent-pi adapter",
  });
});

test("copy and deletePreset are refused as read-only RemoteErrors", async () => {
  const roster = makeRoster();
  for (const call of [() => roster.remoteCopy("pi", "fork"), () => roster.remoteDelete("fork")]) {
    await assert.rejects(
      call,
      (error) => {
        assert.equal(error.code, "agent-preset/read-only");
        assert.equal(error.isDSHRemoteError, true);
        assert.equal(error.details.agentPreset, "fork");
        return true;
      },
    );
  }
});

test("select resolves the single mode and rejects unknown ids", async () => {
  const roster = makeRoster();
  assert.equal(await roster.remoteSelect({}, "pi"), "pi");
  await assert.rejects(() => roster.remoteSelect({}, "nope"), (error) => error.code === "agent-preset/not-found");
  await assert.rejects(() => roster.resolve("nope"), (error) => error.code === "agent-preset/not-found");
});
