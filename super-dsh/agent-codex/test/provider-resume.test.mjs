// CodexProvider identity + resume-robustness contract (plan X1, 2026-09-17):
//  - create/resume REQUIRE the upstream sessionPersistence service;
//  - resume fails CLOSED with stable codes (CodexResumeError):
//      * unknown id (no map entry, no discoverable log)     → SESSION_MAP_MISS
//      * a thread that never started (`threadId: null`)      → NATIVE_THREAD_NEVER_STARTED
//      * a rollout missing in the CURRENT home, pre-spawn    → ROLLOUT_MISSING
//      * a session marked not resumable after a rejection    → NATIVE_REJECTED
// The provider is constructed over a minimal stub Context; the identity checks
// run before any client spawn, so no Codex process is ever touched here.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Context } from "@deepseek-ai/cordis";

const { CodexProvider } = await import("../dist/index.js");
const { sessionRecord, upsertSession } = await import("../dist/session-map.js");
const { clearRolloutHeadCache } = await import("../dist/codex-store.js");
const { setCodexFactory } = await import("../dist/codex-client.js");

const THREAD = "01a0a5cb-e919-7480-81ee-7dcf758aa0aa";
const THREAD_B = "01a0a5cb-e919-7480-81ee-7dcf758aa0bb";

/** A stub Context carrying only the services the provider's boot touches. */
function providerContext(home, { persistence = true } = {}) {
  const ctx = new Context();
  ctx.provide("dshHomePath", home);
  ctx.provide("agents", { setFactory() { } });
  if (persistence === true) {
    ctx.provide("sessionPersistence", {
      calls: [],
      open: async (...args) => {
        ctx.get("sessionPersistence").calls.push(args[1]);
        throw new Error("stub persistence: open() must not be reached");
      },
      create: async () => { throw new Error("stub persistence: create() must not be reached"); },
    });
  } else if (persistence !== false) {
    ctx.provide("sessionPersistence", persistence);
  }
  return ctx;
}

/** Write a minimal rollout for `threadId` under `codexHome` and point CODEX_HOME at it. */
function withCodexHome(threadHeads) {
  const codexHome = mkdtempSync(join(tmpdir(), "aw-codex-resume-home-"));
  const dir = join(codexHome, "sessions", "2026", "09", "17");
  mkdirSync(dir, { recursive: true });
  for (const head of threadHeads) {
    writeFileSync(
      join(dir, `rollout-2026-09-17T00-00-00-${head.id}.jsonl`),
      `${JSON.stringify({ type: "session_meta", payload: head })}\n`,
    );
  }
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  clearRolloutHeadCache();
  return () => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    clearRolloutHeadCache();
  };
}

/** A fake persistence whose read handle serves a DSH log (header + events). */
function logPersistence({ cwd, events }, writeError) {
  const readHandle = {
    header: { cwd },
    read: async () => ({ events, eventState: {} }),
    close: async () => { },
  };
  return {
    open: async (_id, access) => {
      if (access === "read") return readHandle;
      throw new Error(writeError ?? "fake persistence: write open not expected");
    },
    create: async () => { throw new Error("fake persistence: create not expected"); },
  };
}

function userMessageEvent(text) {
  return { type: "user/message", data: { content: [{ type: "text", text }], source: { kind: "user" } } };
}

test("resume fails closed when the DSH session id has no recorded Codex thread", async () => {
  const home = mkdtempSync(join(tmpdir(), "aw-codex-provider-"));
  const ctx = providerContext(home);
  const provider = new CodexProvider(ctx);
  await assert.rejects(
    () => provider.resume(ctx, { resumeSessionId: "session-unknown" }),
    (error) => error.code === "SESSION_MAP_MISS" && /no Codex thread is recorded for this Dash session id/.test(error.message),
  );
});

test("resume fails closed when the recorded thread never materialized", async () => {
  const home = mkdtempSync(join(tmpdir(), "aw-codex-provider-"));
  upsertSession(home, "session-blank", { threadId: null, cwd: home, createdAt: Date.now(), preset: null });
  const ctx = providerContext(home);
  const provider = new CodexProvider(ctx);
  await assert.rejects(
    () => provider.resume(ctx, { resumeSessionId: "session-blank" }),
    (error) => error.code === "NATIVE_THREAD_NEVER_STARTED" && /its Codex thread was never started/.test(error.message),
  );
});

test("resume pre-validates the rollout at RESUME time and fails with ROLLOUT_MISSING before spawning", async () => {
  const home = mkdtempSync(join(tmpdir(), "aw-codex-provider-"));
  const workspace = mkdtempSync(join(tmpdir(), "aw-codex-workspace-"));
  upsertSession(home, "session-pruned", { threadId: THREAD, cwd: workspace, createdAt: Date.now(), preset: "workspace-write" });
  // CODEX_HOME points at an EMPTY current home: the rollout is gone/pruned.
  const restore = withCodexHome([]);
  try {
    const ctx = providerContext(home);
    const provider = new CodexProvider(ctx);
    await assert.rejects(
      () => provider.resume(ctx, { resumeSessionId: "session-pruned" }),
      (error) => error.code === "ROLLOUT_MISSING" && new RegExp(THREAD).test(error.message),
    );
    // The stub persistence was never reached: the gate fires BEFORE any
    // handle claim — and therefore before any client spawn.
    assert.deepEqual(ctx.get("sessionPersistence").calls, []);
  } finally {
    restore();
  }
});

test("a session marked not resumable fails fast with NATIVE_REJECTED", async () => {
  const home = mkdtempSync(join(tmpdir(), "aw-codex-provider-"));
  const workspace = mkdtempSync(join(tmpdir(), "aw-codex-workspace-"));
  upsertSession(home, "session-rejected", { threadId: THREAD, cwd: workspace, createdAt: Date.now(), preset: null, resumable: false });
  const restore = withCodexHome([{ id: THREAD, cwd: workspace }]);
  try {
    const ctx = providerContext(home);
    const provider = new CodexProvider(ctx);
    await assert.rejects(
      () => provider.resume(ctx, { resumeSessionId: "session-rejected" }),
      (error) => error.code === "NATIVE_REJECTED" && /rejected by the native runtime in an earlier attempt/.test(error.message),
    );
    assert.deepEqual(ctx.get("sessionPersistence").calls, []);
  } finally {
    restore();
  }
});

test("resume requires session persistence once the thread is known", async () => {
  const home = mkdtempSync(join(tmpdir(), "aw-codex-provider-"));
  const workspace = mkdtempSync(join(tmpdir(), "aw-codex-workspace-"));
  upsertSession(home, "session-known", { threadId: THREAD, cwd: workspace, createdAt: Date.now(), preset: "danger-full-access" });
  const restore = withCodexHome([{ id: THREAD, cwd: workspace }]);
  try {
    const ctx = providerContext(home, { persistence: false });
    const provider = new CodexProvider(ctx);
    await assert.rejects(
      () => provider.resume(ctx, { resumeSessionId: "session-known" }),
      /cannot resume a Codex session: session persistence is not configured/,
    );
  } finally {
    restore();
  }
});

test("create requires session persistence before anything is spawned", async () => {
  const home = mkdtempSync(join(tmpdir(), "aw-codex-provider-"));
  const ctx = providerContext(home, { persistence: false });
  const provider = new CodexProvider(ctx);
  await assert.rejects(
    () => provider.createAgent(ctx, { sessionId: "session-new" }),
    /cannot create a Codex session: session persistence is not configured/,
  );
});

test("resume re-validates the recorded cwd and refuses a vanished directory", async () => {
  const home = mkdtempSync(join(tmpdir(), "aw-codex-provider-"));
  upsertSession(home, "session-gone", {
    threadId: THREAD,
    cwd: join(home, "no-such-directory"),
    createdAt: Date.now(),
    preset: null,
  });
  const restore = withCodexHome([{ id: THREAD, cwd: join(home, "no-such-directory") }]);
  try {
    const ctx = providerContext(home);
    const provider = new CodexProvider(ctx);
    await assert.rejects(
      () => provider.resume(ctx, { resumeSessionId: "session-gone" }),
      /its recorded working directory no longer exists/,
    );
  } finally {
    restore();
  }
});

// ── C6: followThreadId re-arms on thread change ─────────────────────────────

test("followThreadId re-arms on change: newSession() thread swaps keep the map current", () => {
  const home = mkdtempSync(join(tmpdir(), "aw-codex-provider-"));
  // Production order: create() seeds the full record (with cwd) BEFORE the
  // follow loop patches the thread id in.
  upsertSession(home, "session-swap", { threadId: null, cwd: home, createdAt: Date.now(), preset: null });
  const ctx = providerContext(home);
  const provider = new CodexProvider(ctx);
  const listeners = [];
  const client = {
    threadId: null,
    on(listener) {
      listeners.push(listener);
      return () => {
        listeners.splice(listeners.indexOf(listener), 1);
      };
    },
  };
  provider.followThreadId("session-swap", client);
  // First materialization (the old one-shot path recorded this and stopped).
  client.threadId = "01a0a5cb-e919-7480-81ee-7dcf758aa0c1";
  for (const listener of [...listeners]) listener({ type: "agent_start" });
  assert.equal(sessionRecord(home, "session-swap").threadId, "01a0a5cb-e919-7480-81ee-7dcf758aa0c1");
  // newSession() swaps the thread mid-session — the observer must still fire.
  client.threadId = "01a0a5cb-e919-7480-81ee-7dcf758aa0c2";
  for (const listener of [...listeners]) listener({ type: "agent_start" });
  assert.equal(sessionRecord(home, "session-swap").threadId, "01a0a5cb-e919-7480-81ee-7dcf758aa0c2");
  // The subscription was never torn down (still armed for further changes).
  assert.equal(listeners.length, 1);
});

test("followThreadId ignores null observations and repeats (idempotent upserts)", () => {
  const home = mkdtempSync(join(tmpdir(), "aw-codex-provider-"));
  upsertSession(home, "session-null", { threadId: null, cwd: home, createdAt: Date.now(), preset: null });
  const ctx = providerContext(home);
  const provider = new CodexProvider(ctx);
  const listeners = [];
  const client = { threadId: null, on(l) { listeners.push(l); return () => { }; } };
  provider.followThreadId("session-null", client);
  for (const listener of [...listeners]) listener({ type: "agent_start" });
  assert.equal(sessionRecord(home, "session-null").threadId, null);
  client.threadId = "01a0a5cb-e919-7480-81ee-7dcf758aa0d1";
  for (const listener of [...listeners]) listener({ type: "agent_start" });
  for (const listener of [...listeners]) listener({ type: "agent_start" });
  assert.equal(sessionRecord(home, "session-null").threadId, "01a0a5cb-e919-7480-81ee-7dcf758aa0d1");
  assert.ok(existsSync(join(home, "dsh-sessions.json")));
});
