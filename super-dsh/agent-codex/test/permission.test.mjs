// Permission 3:3 mapping (plan Task 7) — preset table, env override, event replay.
import test from "node:test";
import assert from "node:assert/strict";

const { isPresetName, envApprovalMode, codexApprovalMode, permissionEventsFor, presetFromEvents } = await import("../dist/permission.js");

test("preset table maps 3 Dash presets onto codex sandbox + approvalPolicy", async () => {
  assert.deepEqual(
    ["danger-full-access", "workspace-write", "read-only"].map((preset) => codexApprovalMode(preset)),
    ["never", "on-request", "never"],
  );
  assert.deepEqual(["danger-full-access", "workspace-write", "read-only"].map(isPresetName), [true, true, true]);
  // The sandbox half rides the permission events (Dash-side facts).
  const events = permissionEventsFor("workspace-write", 1000);
  assert.deepEqual(events.map((event) => event.type), ["permission/preset", "sandbox/mode", "approval/policy"]);
  assert.deepEqual(events[1].data, { mode: "workspace-write" });
  assert.deepEqual(events[2].data, { policy: "ask" });
});

test("unknown/missing preset falls back to never (sandbox remains the constraint)", () => {
  assert.equal(codexApprovalMode(undefined), "never");
  assert.equal(codexApprovalMode("yolo"), "never");
  assert.equal(isPresetName("yolo"), false);
});

test("CODEX_APPROVAL_MODE: valid policy overrides, invalid ignored", async () => {
  const original = process.env.CODEX_APPROVAL_MODE;
  try {
    process.env.CODEX_APPROVAL_MODE = "untrusted";
    assert.equal(envApprovalMode(), "untrusted");
    process.env.CODEX_APPROVAL_MODE = "on-failure";
    assert.equal(envApprovalMode(), "on-failure");
    process.env.CODEX_APPROVAL_MODE = "yolo"; // omp vocabulary is not codex vocabulary
    assert.equal(envApprovalMode(), undefined);
    process.env.CODEX_APPROVAL_MODE = "";
    assert.equal(envApprovalMode(), undefined);
    delete process.env.CODEX_APPROVAL_MODE;
    assert.equal(envApprovalMode(), undefined);
  } finally {
    if (original === undefined) delete process.env.CODEX_APPROVAL_MODE;
    else process.env.CODEX_APPROVAL_MODE = original;
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
