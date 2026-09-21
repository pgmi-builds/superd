// HermesProvider identity contract (2026-09-17 "mapping only" model):
//  - create/resume REQUIRE the upstream sessionPersistence service;
//  - resume fails CLOSED when the DSH session id has no recorded Hermes gateway
//    session (unknown id, or a gateway session that never materialized), and
//    never spawns a client.
// The provider is constructed over a minimal stub Context: the identity checks
// run before any client spawn, so no gateway child is ever touched here.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Context } from "@deepseek-ai/cordis";

const { HermesProvider } = await import("../dist/index.js");
const { upsertSession, sessionRecord } = await import("../dist/hermes-store.js");
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

test("resume fails closed when the DSH session id has no recorded Hermes gateway session", async () => {
  const home = mkdtempSync(join(tmpdir(), "aw-hermes-provider-"));
  const ctx = providerContext(home);
  const provider = new HermesProvider(ctx);
  await assert.rejects(
    () => provider.resume(ctx, { resumeSessionId: "session-unknown" }),
    /no Hermes gateway session is recorded for this Dash session id/,
  );
});

test("resume fails closed when the record has no durable gateway session id (predates durable-id capture)", async () => {
  const home = mkdtempSync(join(tmpdir(), "aw-hermes-provider-"));
  upsertSession(home, "session-blank", { gatewaySessionId: null, gatewayStoredSessionId: null, cwd: home, createdAt: Date.now(), preset: null });
  const ctx = providerContext(home);
  const provider = new HermesProvider(ctx);
  await assert.rejects(
    () => provider.resume(ctx, { resumeSessionId: "session-blank" }),
    /no durable gateway session id is recorded \(this record predates durable-id capture/,
  );
});

test("resume requires session persistence once the gateway session is known", async () => {
  const home = mkdtempSync(join(tmpdir(), "aw-hermes-provider-"));
  upsertSession(home, "session-known", { gatewaySessionId: "deadbeef12345678", gatewayStoredSessionId: "20260917_084602_389e64", cwd: home, createdAt: Date.now(), preset: "danger-full-access" });
  const ctx = providerContext(home, { persistence: false });
  const provider = new HermesProvider(ctx);
  await assert.rejects(
    () => provider.resume(ctx, { resumeSessionId: "session-known" }),
    /cannot resume a Hermes session: session persistence is not configured/,
  );
});

test("create requires session persistence before anything is spawned", async () => {
  const home = mkdtempSync(join(tmpdir(), "aw-hermes-provider-"));
  const ctx = providerContext(home, { persistence: false });
  const provider = new HermesProvider(ctx);
  await assert.rejects(
    () => provider.createAgent(ctx, { sessionId: "session-new" }),
    /cannot create a Hermes session: session persistence is not configured/,
  );
});

test("resume re-validates the recorded cwd and refuses a vanished directory", async () => {
  const home = mkdtempSync(join(tmpdir(), "aw-hermes-provider-"));
  upsertSession(home, "session-gone", {
    gatewaySessionId: "deadbeef12345678",
    gatewayStoredSessionId: "20260917_084602_389e64",
    cwd: join(home, "no-such-directory"),
    createdAt: Date.now(),
    preset: null,
  });
  const ctx = providerContext(home);
  const provider = new HermesProvider(ctx);
  await assert.rejects(
    () => provider.resume(ctx, { resumeSessionId: "session-gone" }),
    /its recorded working directory no longer exists/,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// M1 (2026-09-17): stored_session_id DRIFT tolerance — the identity map always
// tracks the latest adopted pair (the gateway may remint the durable key on
// resume). followGatewaySessionId is TS-private → runtime-accessible here.
// ─────────────────────────────────────────────────────────────────────────────

function adoptionClient({ liveId = null, storedId = null } = {}) {
  const adoptedListeners = new Set();
  const client = {
    get sessionId() { return liveId; },
    get storedSessionId() { return storedId; },
    setLive(value) { liveId = value; },
    setStored(value) { storedId = value; },
    adopt(l, s) {
      client.setLive(l);
      client.setStored(s);
      for (const listener of [...adoptedListeners]) listener({ session_id: l, stored_session_id: s });
    },
    on() { return () => { }; },
    onFailure() { return () => { }; },
    onAdopted(listener) {
      adoptedListeners.add(listener);
      return () => adoptedListeners.delete(listener);
    },
    _adoptedCount: () => adoptedListeners.size,
  };
  return client;
}

test("adopted gateway session ids are upserted into the map (create path)", async () => {
  const home = mkdtempSync(join(tmpdir(), "aw-hermes-follow-"));
  // The real create flow persists the record (with cwd) before following.
  upsertSession(home, "session-follow", { gatewaySessionId: null, gatewayStoredSessionId: null, cwd: home, createdAt: Date.now(), preset: null });
  const ctx = providerContext(home);
  const provider = new HermesProvider(ctx);
  const client = adoptionClient();
  provider.followGatewaySessionId("session-follow", client);

  client.adopt("live-1", "stored-1");
  const record = sessionRecord(home, "session-follow");
  assert.equal(record.gatewaySessionId, "live-1");
  assert.equal(record.gatewayStoredSessionId, "stored-1");
});

test("stored_session_id drift: a reminted durable key REPLACES the map entry", async () => {
  const home = mkdtempSync(join(tmpdir(), "aw-hermes-drift-"));
  upsertSession(home, "session-drift", {
    gatewaySessionId: "old-live",
    gatewayStoredSessionId: "old-stored",
    cwd: home,
    createdAt: Date.now(),
    preset: null,
  });
  const ctx = providerContext(home);
  const provider = new HermesProvider(ctx);
  const client = adoptionClient();
  provider.followGatewaySessionId("session-drift", client);

  // Resume adopts with a REMINTED durable key — the map must follow it.
  client.adopt("new-live", "new-stored");
  const record = sessionRecord(home, "session-drift");
  assert.equal(record.gatewaySessionId, "new-live", "live id refreshed");
  assert.equal(record.gatewayStoredSessionId, "new-stored", "reminted durable key replaces the stored one");
  // cwd/createdAt/preset survive the merge (upsert patch semantics)
  assert.equal(record.cwd, home);
  assert.equal(record.preset, null);
});

test("followGatewaySessionId unsubscribes after the first adoption (one materialization per client)", async () => {
  const home = mkdtempSync(join(tmpdir(), "aw-hermes-unsub-"));
  upsertSession(home, "session-unsub", { gatewaySessionId: null, gatewayStoredSessionId: null, cwd: home, createdAt: Date.now(), preset: null });
  const ctx = providerContext(home);
  const provider = new HermesProvider(ctx);
  const client = adoptionClient();
  provider.followGatewaySessionId("session-unsub", client);
  assert.equal(client._adoptedCount(), 1, "subscribed once");
  client.adopt("live-1", "stored-1");
  assert.equal(client._adoptedCount(), 0, "unsubscribed after the first adoption");
  // a second adoption (impossible on a single-session client, but defensively) does not rewrite
  client.adopt("live-2", "stored-2");
  const record = sessionRecord(home, "session-unsub");
  assert.equal(record.gatewayStoredSessionId, "stored-1");
});
