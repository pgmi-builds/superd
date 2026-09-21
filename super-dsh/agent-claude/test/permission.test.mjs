// Permission preset mapping (plan Task 7) — the DSH 3-preset skeleton, the
// additive plan/auto/dontAsk tiers, and the permission/preset event stamp.
import test from "node:test";
import assert from "node:assert/strict";

const { PRESET_TO_CLAUDE, EXTRA_TIERS, claudePermissionMode, isPresetName, permissionEventsFor, presetFromEvents } = await import("../dist/permission.js");

test("the three DSH presets map onto three Claude modes", () => {
  assert.deepEqual(PRESET_TO_CLAUDE, {
    "read-only": "default",
    "workspace-write": "acceptEdits",
    "danger-full-access": "bypassPermissions",
  });
});

test("plan/auto/dontAsk are extra tiers, never folded into the 3-preset skeleton", () => {
  assert.deepEqual([...EXTRA_TIERS], ["plan", "auto", "dontAsk"]);
  for (const tier of EXTRA_TIERS) assert.equal(Object.values(PRESET_TO_CLAUDE).includes(tier), false);
});

test("an unknown preset falls back to the most restrictive skeleton mode", () => {
  assert.equal(claudePermissionMode("nonsense"), "default");
  assert.equal(claudePermissionMode(undefined), "default");
  assert.equal(isPresetName("plan"), false);
  assert.equal(isPresetName("read-only"), true);
});

// --- pins added by the implementer (self-review targets, not brief tests) ----

test("each extra tier maps onto itself while each preset maps onto its Claude mode", () => {
  assert.deepEqual(EXTRA_TIERS.map((tier) => claudePermissionMode(tier)), ["plan", "auto", "dontAsk"]);
  assert.deepEqual(
    ["read-only", "workspace-write", "danger-full-access"].map((preset) => claudePermissionMode(preset)),
    ["default", "acceptEdits", "bypassPermissions"],
  );
});

test("permissionEventsFor stamps the DSH skeleton plus the effective claudeMode", () => {
  const events = permissionEventsFor("workspace-write", 1000);
  assert.deepEqual(events.map((event) => event.type), ["permission/preset", "sandbox/mode", "approval/policy"]);
  assert.deepEqual(events[0].data, { preset: "workspace-write", claudeMode: "acceptEdits" });
  assert.deepEqual(events[1].data, { mode: "workspace-write" });
  assert.deepEqual(events[2].data, { policy: "ask" });
});

test("presetFromEvents round-trips every preset permissionEventsFor produced", () => {
  for (const preset of ["read-only", "workspace-write", "danger-full-access"]) {
    assert.equal(presetFromEvents(permissionEventsFor(preset, 7)), preset);
  }
  // An extra tier is not a DSH preset name, so it is not revivable from the log.
  assert.equal(presetFromEvents([{ type: "permission/preset", time: 1, data: { preset: "plan" } }]), undefined);
  assert.equal(presetFromEvents([]), undefined);
});

// --- RC-5 permission-authority pins -----------------------------------------

const { presetFromClaudeMode, modeChangePatch } = await import("../dist/permission.js");
const { upsertSession, sessionRecord } = await import("../dist/session-map.js");
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("presetFromClaudeMode inverts the skeleton exactly; extra tiers name no preset", () => {
  for (const [preset, mode] of Object.entries(PRESET_TO_CLAUDE)) {
    assert.equal(presetFromClaudeMode(mode), preset);
  }
  assert.equal(presetFromClaudeMode("plan"), undefined);
  assert.equal(presetFromClaudeMode("auto"), undefined);
  assert.equal(presetFromClaudeMode("dontAsk"), undefined);
  assert.equal(presetFromClaudeMode("nonsense"), undefined);
});

test("modeChangePatch upserts {claudeMode, preset} together; an extra tier changes the mode only", () => {
  assert.deepEqual(modeChangePatch("acceptEdits"), { claudeMode: "acceptEdits", preset: "workspace-write" });
  assert.deepEqual(modeChangePatch("bypassPermissions"), { claudeMode: "bypassPermissions", preset: "danger-full-access" });
  assert.deepEqual(modeChangePatch("default"), { claudeMode: "default", preset: "read-only" });
  // Extra tiers: mode-only — no preset key, so upsertSession keeps the stored one.
  assert.deepEqual(modeChangePatch("plan"), { claudeMode: "plan" });
  assert.deepEqual(modeChangePatch("auto"), { claudeMode: "auto" });
  assert.deepEqual(modeChangePatch("dontAsk"), { claudeMode: "dontAsk" });
});

test("onModeChange keeps the session map consistent with the log fold (skeleton switch, then extra tier)", () => {
  const home = mkdtempSync(join(tmpdir(), "aw-claude-perm-"));
  const id = "session-mode-map";
  // Create: the record carries the resolved preset + mode (single source).
  upsertSession(home, id, {
    claudeSessionId: "01234567-89ab-4cde-8f01-23456789abcd",
    ...modeChangePatch("acceptEdits"),
    cwd: home,
    createdAt: Date.now(),
  });
  assert.equal(sessionRecord(home, id).preset, "workspace-write");
  assert.equal(sessionRecord(home, id).claudeMode, "acceptEdits");

  // Live switch onto a skeleton mode: {claudeMode, preset} move TOGETHER.
  upsertSession(home, id, modeChangePatch("default"));
  assert.equal(sessionRecord(home, id).claudeMode, "default");
  assert.equal(sessionRecord(home, id).preset, "read-only");

  // Live switch onto an extra tier: the recorded preset survives untouched.
  upsertSession(home, id, modeChangePatch("plan"));
  assert.equal(sessionRecord(home, id).claudeMode, "plan");
  assert.equal(sessionRecord(home, id).preset, "read-only");

  // The log fold still answers the revivable preset for resume:
  const foldedEvents = permissionEventsFor("read-only", 1);
  assert.equal(presetFromEvents(foldedEvents), "read-only");
});
