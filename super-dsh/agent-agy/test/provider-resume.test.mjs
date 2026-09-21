// AgyProvider identity contract (mapping-only + blank-session tolerance,
// mirroring pi provider-resume, 2026-09-18 §14-i doctrine):
//  - create/resume REQUIRE the upstream sessionPersistence service;
//  - a never-materialized session (no record, or conversationId null/empty)
//    resumes AS FRESH — the Dash host eagerly resumes on view/model-change,
//    so failing here broke every blank new session (composer + selector);
//  - a MISSING record with conversation-bearing DSH log content is a genuine
//    orphan → fail closed (CONVERSATION_NOT_FOUND), never scan ~/.gemini.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Context } from "@deepseek-ai/cordis";

const { AgyProvider } = await import("../dist/index.js");
const { upsertSession, sessionRecord } = await import("../dist/agy-sessions.js");

function providerContext(home, { persistence = true, events = [] } = {}) {
  const ctx = new Context();
  ctx.provide("dshHomePath", home);
  ctx.provide("agents", { setFactory() { } });
  if (persistence) {
    ctx.provide("sessionPersistence", {
      // 'read' serves the orphan probe; 'write' must never be reached in these
      // identity-gate tests.
      open: async (_id, mode) => {
        if (mode === "read") {
          return {
            read: async () => ({ events, eventState: undefined }),
            close: async () => { },
            header: {},
            inheritedEventCount: 0,
          };
        }
        throw new Error("stub persistence: open('write') must not be reached");
      },
      create: async () => { throw new Error("stub persistence: create() must not be reached"); },
    });
  }
  return ctx;
}

const CONVERSATION_EVENTS = [
  { type: "turn/start", seq: 2, time: 2, data: { turn: 1 } },
  { type: "user/message", seq: 3, time: 3, data: { source: { kind: "user" } } },
];

test("blank resume: no record at all → tolerated as fresh (mapping gate must not throw)", async () => {
  const home = mkdtempSync(join(tmpdir(), "aw-agy-provider-"));
  const ctx = providerContext(home); // empty log → blank
  const provider = new AgyProvider(ctx);
  await assert.rejects(
    () => provider.resume(ctx, { resumeSessionId: "session-unknown" }),
    (error) => error.code !== "CONVERSATION_NOT_FOUND",
  );
});

test("blank resume: record with conversationId null (never a turn) → fresh, not fail-closed", async () => {
  const home = mkdtempSync(join(tmpdir(), "aw-agy-provider-"));
  upsertSession(home, "session-blank", { conversationId: null, cwd: home, createdAt: Date.now(), preset: null });
  const ctx = providerContext(home);
  const provider = new AgyProvider(ctx);
  await assert.rejects(
    () => provider.resume(ctx, { resumeSessionId: "session-blank" }),
    (error) => error.code !== "CONVERSATION_NOT_FOUND",
  );
});

test("orphan: missing record but DSH log carries conversation content → fail closed", async () => {
  const home = mkdtempSync(join(tmpdir(), "aw-agy-provider-"));
  const ctx = providerContext(home, { events: CONVERSATION_EVENTS });
  const provider = new AgyProvider(ctx);
  await assert.rejects(
    () => provider.resume(ctx, { resumeSessionId: "session-orphan" }),
    (error) => error.code === "CONVERSATION_NOT_FOUND" && /start a new session/.test(error.message),
  );
});

test("create requires session persistence before anything is spawned", async () => {
  const home = mkdtempSync(join(tmpdir(), "aw-agy-provider-"));
  const ctx = providerContext(home, { persistence: false });
  const provider = new AgyProvider(ctx);
  await assert.rejects(
    () => provider.createAgent(ctx, { sessionId: "session-new" }),
    /cannot create an Agy session: session persistence is not configured/,
  );
});

test("resume re-validates the recorded cwd and refuses a vanished directory", async () => {
  const home = mkdtempSync(join(tmpdir(), "aw-agy-provider-"));
  upsertSession(home, "session-gone", {
    conversationId: "cid-1",
    cwd: join(home, "no-such-directory"),
    createdAt: Date.now(),
    preset: null,
  });
  const ctx = providerContext(home);
  const provider = new AgyProvider(ctx);
  await assert.rejects(
    () => provider.resume(ctx, { resumeSessionId: "session-gone" }),
    /its recorded working directory no longer exists/,
  );
});

test("mapping round-trip: upsert then sessionRecord returns the conversation id", () => {
  const home = mkdtempSync(join(tmpdir(), "aw-agy-map-"));
  upsertSession(home, "session-a", { conversationId: null, cwd: home, createdAt: Date.now(), preset: null });
  upsertSession(home, "session-a", { conversationId: "conv-9" });
  const record = sessionRecord(home, "session-a");
  assert.equal(record.conversationId, "conv-9");
  assert.equal(record.cwd, home, "cwd survives the merge");
});
