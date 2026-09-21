// src/pi-client.ts — PiSessionClient over one pi AgentSession.
// Lazy (zero IO until ensureStarted), injectable session factory, event pump
// through projectSessionEvent, failure channel via onFailure.
import assert from "node:assert/strict";
import { test } from "node:test";

const models = await import("../dist/models.js");
const { setPiModelRuntimeFactory, clearPiCatalogForTests } = models;
const { PiSessionClient, setPiSessionFactory } = await import("../dist/pi-client.js");

/** A controllable fake pi AgentSession. */
function fakeSession(overrides = {}) {
  const listeners = new Set();
  const calls = { prompt: [], steer: [], followUp: [], setModel: [], setThinkingLevel: [], compact: [], abort: 0, dispose: 0 };
  const session = {
    sessionFile: "/pi/sessions/s1.jsonl",
    sessionId: "pi-s1",
    isStreaming: false,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit(event) {
      for (const fn of [...listeners]) fn(event);
    },
    async prompt(text) {
      calls.prompt.push(text);
    },
    async steer(text) {
      calls.steer.push(text);
    },
    async followUp(text) {
      calls.followUp.push(text);
    },
    setModel(model) {
      calls.setModel.push(model);
    },
    setThinkingLevel(level) {
      calls.setThinkingLevel.push(level);
    },
    async compact(instructions) {
      calls.compact.push(instructions);
      return { summary: "done" };
    },
    async abort() {
      calls.abort += 1;
    },
    dispose() {
      calls.dispose += 1;
    },
    ...overrides,
  };
  return { session, calls, listeners };
}

test("lazy: spawn performs zero IO until ensureStarted", async () => {
  let factoryCalls = 0;
  setPiSessionFactory(async () => {
    factoryCalls += 1;
    return fakeSession().session;
  });
  const client = await PiSessionClient.spawn([], "/tmp/cwd", { kind: "create" });
  assert.equal(factoryCalls, 0);
  assert.equal(client.spawned, false);
  assert.equal(client.sessionFile, null);

  await client.ensureStarted();
  assert.equal(factoryCalls, 1);
  assert.equal(client.spawned, true);
  assert.equal(client.sessionFile, "/pi/sessions/s1.jsonl");
  await client.close();
});

test("ensureStarted passes cwd + mode (resume opens the recorded file); repeat calls are memoized", async () => {
  const seen = [];
  let factoryCalls = 0;
  setPiSessionFactory(async (config) => {
    factoryCalls += 1;
    seen.push(config);
    return fakeSession().session;
  });
  const client = await PiSessionClient.spawn([], "/tmp/res", { kind: "resume", sessionFile: "/pi/sessions/old.jsonl" });
  await client.ensureStarted();
  await client.ensureStarted();
  assert.equal(factoryCalls, 1);
  assert.deepEqual(seen, [{ cwd: "/tmp/res", mode: { kind: "resume", sessionFile: "/pi/sessions/old.jsonl" } }]);
  await client.close();
});

test("create mode carries the launch-only toolset", async () => {
  const seen = [];
  setPiSessionFactory(async (config) => {
    seen.push(config);
    return fakeSession().session;
  });
  const client = await PiSessionClient.spawn([], "/tmp/ro", { kind: "create", tools: ["read", "grep", "find", "ls"] });
  await client.ensureStarted();
  assert.deepEqual(seen[0].mode, { kind: "create", tools: ["read", "grep", "find", "ls"] });
  await client.close();
});

test("events pump through the projection to on() listeners", async () => {
  const fake = fakeSession();
  setPiSessionFactory(async () => fake.session);
  const client = await PiSessionClient.spawn([], "/tmp/cwd", { kind: "create" });
  const wire = [];
  client.on((event) => wire.push(event));
  await client.ensureStarted();

  fake.session.emit({ type: "agent_start" });
  fake.session.emit({ type: "session_info_changed", name: "titled" });
  fake.session.emit({ type: "queue_update", steering: [], followUp: [] });

  assert.deepEqual(wire, [{ type: "agent_start" }, { type: "session_title", name: "titled" }]);
  await client.close();
});

test("prompt/steer/followUp are fire-and-forget; rejections reach onFailure", async () => {
  const fake = fakeSession();
  setPiSessionFactory(async () => fake.session);
  const client = await PiSessionClient.spawn([], "/tmp/cwd", { kind: "create" });
  const failures = [];
  client.onFailure((error) => failures.push(error));
  await client.ensureStarted();

  await client.prompt("hello");
  await client.steer("mid-flight");
  await client.followUp("later");
  assert.deepEqual(fake.calls.prompt, ["hello"]);
  assert.deepEqual(fake.calls.steer, ["mid-flight"]);
  assert.deepEqual(fake.calls.followUp, ["later"]);

  fake.session.prompt = async () => {
    throw new Error("boom");
  };
  await client.prompt("bad");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(failures.length, 1);
  assert.match(String(failures[0]), /boom/);
  await client.close();
});

test("setModel threads (provider, modelId) straight into the runtime; unknown and incomplete pairs are no-ops", async () => {
  clearPiCatalogForTests();
  const getModelCalls = [];
  setPiModelRuntimeFactory(async () => ({
    getAvailable: async () => [],
    getModel: (provider, id) => {
      getModelCalls.push([provider, id]);
      return provider === "prov-a" && id === "m1" ? { id: "m1", provider: "prov-a" } : undefined;
    },
  }));

  const fake = fakeSession();
  setPiSessionFactory(async () => fake.session);
  const client = await PiSessionClient.spawn([], "/tmp/cwd", { kind: "create" });
  await client.ensureStarted();

  await client.setModel("prov-a", "m1");
  assert.deepEqual(getModelCalls, [["prov-a", "m1"]]);
  assert.deepEqual(fake.calls.setModel, [{ id: "m1", provider: "prov-a" }]);

  // unknown pair → runtime miss → no session.setModel, no throw
  await client.setModel("prov-x", "missing");
  assert.equal(fake.calls.setModel.length, 1);
  assert.deepEqual(getModelCalls.at(-1), ["prov-x", "missing"]);

  // incomplete pair → logged no-op, runtime untouched
  await client.setModel("", "m1");
  await client.setModel("prov-a", "");
  assert.equal(getModelCalls.length, 2);

  await client.close();
  clearPiCatalogForTests();
});

test("compact/setThinkingLevel/abort route to the session; close disposes once and fails later ops", async () => {
  const fake = fakeSession();
  setPiSessionFactory(async () => fake.session);
  const client = await PiSessionClient.spawn([], "/tmp/cwd", { kind: "create" });
  await client.ensureStarted();

  await client.compact("tidy");
  client.setThinkingLevel("high");
  const abort = await client.abort();
  assert.equal(abort.success, true);
  assert.deepEqual(fake.calls.compact, ["tidy"]);
  assert.deepEqual(fake.calls.setThinkingLevel, ["high"]);
  assert.equal(fake.calls.abort, 1);

  await client.close();
  await client.close();
  assert.equal(fake.calls.dispose, 1);
  assert.equal(client.spawned, false);
  assert.throws(() => client.getState(), /closed/);
});
