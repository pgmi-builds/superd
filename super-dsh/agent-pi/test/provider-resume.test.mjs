// PiProvider identity contract ("mapping only" + blank-session tolerance,
// 2026-09-18 dev-rules §14 i / omp-web doctrine):
//  - create/resume REQUIRE the upstream sessionPersistence service;
//  - a session whose pi side never materialized (no record, or
//    `sessionFile: null`) resumes AS FRESH — the identity gate PASSES and
//    construction proceeds (the Dash host eagerly resumes on view, so the
//    old fail-closed broke every blank new session's composer);
//  - a MISSING record with conversation content in the DSH log is a genuine
//    orphan and still fails LOUD.
// The provider is constructed over a minimal stub Context: the identity
// checks run before any session start, so no pi object is ever created here.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Context } from "@deepseek-ai/cordis";

const { PiProvider } = await import("../dist/index.js");
const { upsertSession } = await import("../dist/session-map.js");

/** A stub Context carrying only the services the provider's boot touches. */
function providerContext(home, { persistence = true } = {}) {
  const ctx = new Context();
  ctx.provide("dshHomePath", home);
  ctx.provide("agents", { setFactory() { } });
  if (persistence) {
    ctx.provide("sessionPersistence", {
      open: async () => { throw new Error("stub persistence: open() must not be reached"); },
      create: async () => { throw new Error("stub persistence: create() must not be reached"); },
    });
  }
  return ctx;
}

/** Persistence stub whose stored log reads back `events`. */
function logContext(home, events) {
  const ctx = providerContext(home, { persistence: false });
  ctx.provide("sessionPersistence", {
    open: async () => ({
      read: async () => ({ events }),
      close: async () => { },
      append: async () => { },
      header: { id: "stub", cwd: home },
      inheritedEventCount: 0,
    }),
    create: async () => { throw new Error("stub persistence: create() must not be reached"); },
  });
  return ctx;
}

test("resume tolerates a blank session with NO record (empty log) — the identity gate passes", async () => {
  const home = mkdtempSync(join(tmpdir(), "aw-pi-provider-"));
  const ctx = logContext(home, []);
  const provider = new PiProvider(ctx);
  // The gate must NOT fail-closed anymore: construction proceeds past the
  // identity checks (deeper wiring may throw on this stub context — anything
  // EXCEPT the old identity errors is a pass).
  await assert.rejects(
    () => provider.resume(ctx, { resumeSessionId: "session-unknown" }),
    (error) => !/no pi session is recorded for this Dash session id|never started \(no session file recorded\)/.test(String(error)),
  );
});

test("resume fails LOUD for a conversation-bearing orphan (missing record + content in the log)", async () => {
  const home = mkdtempSync(join(tmpdir(), "aw-pi-provider-"));
  const ctx = logContext(home, [{ type: "turn/start", data: { turn: 1 } }]);
  const provider = new PiProvider(ctx);
  await assert.rejects(
    () => provider.resume(ctx, { resumeSessionId: "session-orphan" }),
    /no pi session is recorded for this Dash session id/,
  );
});

test("resume tolerates a never-materialized record (sessionFile null) — fresh lazy shell", async () => {
  const home = mkdtempSync(join(tmpdir(), "aw-pi-provider-"));
  upsertSession(home, "session-blank", { sessionFile: null, cwd: home, createdAt: Date.now(), preset: null });
  const ctx = logContext(home, []);
  const provider = new PiProvider(ctx);
  await assert.rejects(
    () => provider.resume(ctx, { resumeSessionId: "session-blank" }),
    (error) => !/no pi session is recorded for this Dash session id|never started \(no session file recorded\)/.test(String(error)),
  );
});

test("resume requires session persistence once the session file is known", async () => {
  const home = mkdtempSync(join(tmpdir(), "aw-pi-provider-"));
  upsertSession(home, "session-known", {
    sessionFile: "/pi/agent/sessions/--x--/s1.jsonl",
    cwd: home,
    createdAt: Date.now(),
    preset: "danger-full-access",
  });
  const ctx = providerContext(home, { persistence: false });
  const provider = new PiProvider(ctx);
  await assert.rejects(
    () => provider.resume(ctx, { resumeSessionId: "session-known" }),
    /cannot resume a pi session: session persistence is not configured/,
  );
});

test("create requires session persistence before anything is started", async () => {
  const home = mkdtempSync(join(tmpdir(), "aw-pi-provider-"));
  const ctx = providerContext(home, { persistence: false });
  const provider = new PiProvider(ctx);
  await assert.rejects(
    () => provider.createAgent(ctx, { sessionId: "session-new" }),
    /cannot create a pi session: session persistence is not configured/,
  );
});

test("resume re-validates the recorded cwd and refuses a vanished directory", async () => {
  const home = mkdtempSync(join(tmpdir(), "aw-pi-provider-"));
  upsertSession(home, "session-gone", {
    sessionFile: "/pi/agent/sessions/--x--/s1.jsonl",
    cwd: join(home, "no-such-directory"),
    createdAt: Date.now(),
    preset: null,
  });
  const ctx = providerContext(home);
  const provider = new PiProvider(ctx);
  await assert.rejects(
    () => provider.resume(ctx, { resumeSessionId: "session-gone" }),
    /its recorded working directory no longer exists/,
  );
});
