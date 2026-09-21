// Hermes permission mapping (plan Task 7 Step 1):
//  - preset NAME vocabulary survives (record-only, no launch flag);
//  - `approvalChoiceFromOutcome` is the NEW pure outcome → gateway choice mapping;
//  - `envApprovalMode` reads HERMES_APPROVAL_MODE (known preset names only).
import test from "node:test";
import assert from "node:assert/strict";

const { isPresetName, envApprovalMode, approvalChoiceFromOutcome, presetFromEvents } = await import("../dist/permission.js");

test("isPresetName narrows the three Dash presets", () => {
  assert.deepEqual(["danger-full-access", "workspace-write", "read-only"].map(isPresetName), [true, true, true]);
  assert.equal(isPresetName("yolo"), false);
  assert.equal(isPresetName(undefined), false);
});

test("approvalChoiceFromOutcome: allowed-once grants once; allowed-always only with the option", () => {
  assert.equal(approvalChoiceFromOutcome("allowed-once"), "once");
  assert.equal(approvalChoiceFromOutcome("allowed-once", ["once", "deny"]), "once");
  // allowed-always is NOT offered → deny (the gateway would reject an unknown "always").
  assert.equal(approvalChoiceFromOutcome("allowed-always", ["once", "deny"]), "deny");
  assert.equal(approvalChoiceFromOutcome("allowed-always", undefined), "deny");
  assert.equal(approvalChoiceFromOutcome("allowed-always", ["once", "session", "always", "deny"]), "always");
});

test("approvalChoiceFromOutcome: every other outcome fails closed to deny", () => {
  assert.equal(approvalChoiceFromOutcome("rejected"), "deny");
  assert.equal(approvalChoiceFromOutcome("cancelled"), "deny");
  assert.equal(approvalChoiceFromOutcome("unavailable"), "deny");
  assert.equal(approvalChoiceFromOutcome(undefined), "deny");
  assert.equal(approvalChoiceFromOutcome("garbage"), "deny");
  assert.equal(approvalChoiceFromOutcome(null), "deny");
});

test("HERMES_APPROVAL_MODE: a known preset is recorded, an invalid value ignored", async () => {
  const original = process.env.HERMES_APPROVAL_MODE;
  try {
    process.env.HERMES_APPROVAL_MODE = "workspace-write";
    assert.equal(envApprovalMode(), "workspace-write");
    process.env.HERMES_APPROVAL_MODE = "on-request"; // hermes has no approval-mode vocabulary
    assert.equal(envApprovalMode(), undefined);
    process.env.HERMES_APPROVAL_MODE = "";
    assert.equal(envApprovalMode(), undefined);
    delete process.env.HERMES_APPROVAL_MODE;
    assert.equal(envApprovalMode(), undefined);
  } finally {
    if (original === undefined) delete process.env.HERMES_APPROVAL_MODE;
    else process.env.HERMES_APPROVAL_MODE = original;
  }
});

test("presetFromEvents: last permission/preset event wins, others ignored", () => {
  const events = [
    { type: "permission/preset", seq: 0, time: 1, data: { preset: "read-only" } },
    { type: "turn/start", seq: 1, time: 2, data: { turn: 1 } },
    { type: "permission/preset", seq: 2, time: 3, data: { preset: "danger-full-access" } },
    { type: "permission/preset", seq: 3, time: 4, data: { preset: "not-a-preset" } },
  ];
  assert.equal(presetFromEvents(events), "danger-full-access");
  assert.equal(presetFromEvents([{ type: "turn/start", seq: 0, time: 1, data: { turn: 1 } }]), undefined);
  assert.equal(presetFromEvents([]), undefined);
});
