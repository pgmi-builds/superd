// src/permission.ts — Dash permission preset ↔ pi launch-only toolset mapping.
// pi has no per-action approval channel; the preset is realized once, at
// session creation, as a toolset (ruling 7).
import assert from "node:assert/strict";
import { test } from "node:test";

const { isPresetName, envApprovalMode, piToolset, defaultPermissionPreset, presetFromEvents, permissionEventsFor } = await import("../dist/permission.js");

test("preset table maps onto pi toolsets (launch-only)", () => {
  assert.equal(piToolset("danger-full-access"), undefined); // pi default tools
  assert.equal(piToolset("workspace-write"), undefined);
  assert.deepEqual(piToolset("read-only"), ["read", "grep", "find", "ls"]);
  assert.equal(piToolset(undefined), undefined);
  assert.equal(piToolset("nonsense"), undefined);
});

test("env override selects a preset NAME and ignores junk", () => {
  process.env.PI_APPROVAL_MODE = "read-only";
  try {
    assert.equal(envApprovalMode(), "read-only");
  } finally {
    delete process.env.PI_APPROVAL_MODE;
  }
  process.env.PI_APPROVAL_MODE = "turbo";
  try {
    assert.equal(envApprovalMode(), undefined);
  } finally {
    delete process.env.PI_APPROVAL_MODE;
  }
});

test("preset events are recognized and stamped as the three-part prefix", () => {
  assert.equal(isPresetName("workspace-write"), true);
  const time = 1_700_000_000_000;
  const events = permissionEventsFor("read-only", time);
  assert.deepEqual(
    events.map((e) => e.type),
    ["permission/preset", "sandbox/mode", "approval/policy"],
  );
  assert.deepEqual(events[0].data, { preset: "read-only" });
  assert.deepEqual(events[1].data, { mode: "read-only" });
  assert.deepEqual(events[2].data, { policy: "ask" });
  assert.equal(presetFromEvents(events), "read-only");
  assert.equal(presetFromEvents([]), undefined);
});
