// agent-claude/test/session-id.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

const { isClaudeSessionId, claudeSessionIdFromDsh, CLAUDE_SESSION_ID_RE } = await import("../dist/session-id.js");

test("the predicate is version-agnostic and case-insensitive", () => {
  assert.match("01a04826-6d1d-701f-adc3-b834dffc82c5", CLAUDE_SESSION_ID_RE); // v7
  assert.match("f47ac10b-58cc-4372-a567-0e02b2c3d479", CLAUDE_SESSION_ID_RE); // v4
  assert.match("F47AC10B-58CC-4372-A567-0E02B2C3D479", CLAUDE_SESSION_ID_RE);
  assert.equal(isClaudeSessionId("{f47ac10b-58cc-4372-a567-0e02b2c3d479}"), false);
  assert.equal(isClaudeSessionId("urn:uuid:f47ac10b-58cc-4372-a567-0e02b2c3d479"), false);
});

test("claudeSessionIdFromDsh strips the session- prefix and accepts a UUIDv7 tail", () => {
  assert.equal(
    claudeSessionIdFromDsh("session-01a04826-6d1d-701f-adc3-b834dffc82c5"),
    "01a04826-6d1d-701f-adc3-b834dffc82c5",
  );
});

test("claudeSessionIdFromDsh returns undefined for a non-UUID DSH id (route B fallback)", () => {
  assert.equal(claudeSessionIdFromDsh("session-1"), undefined);
  const forced = "session-f47ac10b-58cc-4372-a567-0e02b2c3d479";
  assert.equal(claudeSessionIdFromDsh(forced), "f47ac10b-58cc-4372-a567-0e02b2c3d479");
});
