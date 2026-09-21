// HermesAgent pure helpers (plan Task 7 Step 3, fixture-grounded; 2026-09-17 M1 update):
//  - convertUsage maps the captured `message.complete.usage` shape (input/output/
//    reasoning; NO cache_read field) onto Dash TokenUsage — no invented cache —
//    and SYNTHESIZES the per-attempt totalTokens = input + output (the gateway's
//    own `total` is context-wide: total = prompt + completion, prompt === context_used);
//  - classifyTurnError maps turn failures onto stable UI codes
//    (NATIVE_SESSION_GONE / GATEWAY_CRASH / CLIENT_CLOSED);
//  - wireFailure classifies `stopReason:"error"` messages;
//  - convertContent maps wire blocks onto Dash content blocks.
import test from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
const { convertUsage, classifyTurnError, wireFailure, convertContent, HermesAgent } = await import("../dist/agent.js");
const { GatewayRpcError } = await import("../dist/hermes-client.js");

const fixtureUsage = {
  model: "deepseek-v4-pro",
  input: 19251,
  output: 2,
  reasoning: 0,
  prompt: 26803,
  completion: 2,
  total: 26805,
  calls: 1,
  context_used: 26803,
  context_max: 1000000,
  context_percent: 3,
  compressions: 0,
  cache_hit_pct: 28,
};

test("convertUsage maps the fixture message.complete.usage shape (authority: turn[11])", () => {
  // totalTokens is SYNTHESIZED input+output (19253), NOT the context-wide gateway total 26805.
  assert.deepEqual(convertUsage(fixtureUsage), { inputTokens: 19251, outputTokens: 2, totalTokens: 19253, reasoningTokens: 0 });
  assert.notEqual(convertUsage(fixtureUsage).totalTokens, fixtureUsage.total);
});

test("convertUsage maps reasoning and drops the percentage cache_hit_pct (no cache_read field)", () => {
  const usage = { input: 10, output: 4, reasoning: 3, cache_hit_pct: 28 };
  assert.deepEqual(convertUsage(usage), { inputTokens: 10, outputTokens: 4, totalTokens: 14, reasoningTokens: 3 });
});

test("convertUsage drops reasoningTokens when reasoning exceeds output (fold would reject)", () => {
  const usage = { input: 10, output: 2, reasoning: 5 };
  assert.deepEqual(convertUsage(usage), { inputTokens: 10, outputTokens: 2, totalTokens: 12 });
});

test("classifyTurnError: GatewayRpcError 4001/4006 → NATIVE_SESSION_GONE naming the stored session", () => {
  for (const code of [4001, 4006]) {
    const error = new GatewayRpcError("session.resume", "session not found", code);
    assert.deepEqual(
      classifyTurnError(error, { clientUsable: true, storedSessionId: "20260917_084602_389e64" }),
      {
        message: `session.resume: session not found (code ${code}) (stored gateway session 20260917_084602_389e64 is gone — start a new session)`,
        code: "NATIVE_SESSION_GONE",
      },
    );
  }
  // unknown stored id still classifies, with a placeholder in the message
  const gone = classifyTurnError(new GatewayRpcError("session.resume", "gone", 4001), { clientUsable: true, storedSessionId: null });
  assert.equal(gone.code, "NATIVE_SESSION_GONE");
  assert.match(gone.message, /stored gateway session unknown is gone/);
  // other RPC codes are NOT session-gone
  assert.equal(classifyTurnError(new GatewayRpcError("prompt.submit", "refused", 4090), { clientUsable: true, storedSessionId: "k" }).code, "UNKNOWN");
});

test("classifyTurnError: child crash → GATEWAY_CRASH; dead client → CLIENT_CLOSED; else UNKNOWN", () => {
  assert.deepEqual(
    classifyTurnError(new Error("gateway child exited (code=1); stderr tail:\nboom"), { clientUsable: false, storedSessionId: null }),
    { message: "gateway child exited (code=1); stderr tail:\nboom", code: "GATEWAY_CRASH" },
  );
  assert.deepEqual(
    classifyTurnError(new Error("gateway child error: spawn failed"), { clientUsable: false, storedSessionId: null }).code,
    "GATEWAY_CRASH",
  );
  assert.deepEqual(
    classifyTurnError(new Error("hermes gateway client closed"), { clientUsable: false, storedSessionId: null }),
    { message: "hermes gateway client closed", code: "CLIENT_CLOSED" },
  );
  // a usable client's ordinary error stays UNKNOWN (wireFailure owns model errors)
  assert.deepEqual(
    classifyTurnError(new Error("approval timed out"), { clientUsable: true, storedSessionId: null }),
    { message: "approval timed out", code: "UNKNOWN" },
  );
});


test("convertUsage returns undefined for empty/non-object usage", () => {
  assert.equal(convertUsage({ input: 0, output: 0, reasoning: 0 }), undefined);
  assert.equal(convertUsage(null), undefined);
  assert.equal(convertUsage("nope"), undefined);
  assert.equal(convertUsage(undefined), undefined);
});

test("wireFailure classifies stopReason error messages (quota wording before 403)", () => {
  assert.deepEqual(wireFailure({ role: "assistant", stopReason: "error", errorMessage: "rate limit exceeded" }),
    { message: "rate limit exceeded", code: "QUOTA" });
  assert.deepEqual(wireFailure({ role: "assistant", stopReason: "error", errorMessage: "x", errorStatus: 429 }),
    { message: "x", code: "RATE_LIMIT" });
  assert.deepEqual(wireFailure({ role: "assistant", stopReason: "error", errorMessage: "boom" }),
    { message: "boom", code: "UNKNOWN" });
  assert.equal(wireFailure({ role: "assistant", content: [] }), undefined);
});

test("convertContent maps text/thinking/toolCall and drops unknown blocks", () => {
  const blocks = [
    { type: "text", text: "hi" },
    { type: "thinking", thinking: "ponder" },
    { type: "toolCall", id: "t1", name: "bash", arguments: "{\"cmd\":\"ls\"}" },
    { type: "image", url: "x" },
  ];
  const out = convertContent(blocks);
  assert.deepEqual(out.map((b) => b.type), ["text", "reasoning", "tool-call"]);
  assert.deepEqual(out[2], { type: "tool-call", id: "t1", name: "bash", arguments: "{\"cmd\":\"ls\"}" });
  assert.deepEqual(convertContent(undefined), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// HermesAgent state-machine (fake-client fixture replay — I2 fix r1)
// ─────────────────────────────────────────────────────────────────────────────

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeFakeSession() {
  const events = [];
  let seq = 0;
  return {
    id: "session-test",
    events,
    snapshotEvents: () => [...events],
    append: (type, data) => {
      seq += 1;
      const event = { type, seq, time: Date.now(), data };
      events.push(event);
      return event;
    },
  };
}

function makeFakeClient({ steerRejects = false, neverSettle = false, usable = true, resumeFailures = [] } = {}) {
  const wire = [];
  const failures = [];
  let sid = null;
  let sysPrompt = "";
  let title = "";
  const promptDeferreds = [];
  const calls = { prompt: [], steer: [], interrupt: 0, compress: 0, createSession: [], resumeSession: [] };
  const client = {
    get sessionId() { return sid; },
    set sessionId(v) { sid = v; },
    get systemPrompt() { return sysPrompt; },
    set systemPrompt(v) { sysPrompt = v; },
    get title() { return title; },
    set title(v) { title = v; },
    on(fn) { wire.push(fn); return () => { }; },
    onAdopted() { return () => { }; },
    onFailure(fn) { failures.push(fn); return () => { }; },
    onApproval() { return () => { }; },
    // liveness getters (2026-09-17 ruling 4): the agent's failure path reads these
    get usable() { return usable; },
    get closed() { return !usable && false; }, // fake: only "failure" terminal states matter here
    get failure() { return usable ? null : new Error("hermes gateway client closed"); },
    ensureStarted: async () => { },
    createSession: async (opts) => { calls.createSession.push(opts); sid = "gw-1"; return { session_id: "gw-1" }; },
    resumeSession: async (target) => {
      calls.resumeSession.push(target);
      if (calls.resumeSession.length <= resumeFailures.length) throw resumeFailures[calls.resumeSession.length - 1];
      sid = target;
      return { session_id: target };
    },
    prompt: async (text) => {
      calls.prompt.push(text);
      if (neverSettle) return new Promise(() => { });
      return new Promise((resolve) => promptDeferreds.push(resolve));
    },
    steer: async (text) => {
      calls.steer.push(text);
      if (steerRejects) throw new Error("steer rejected by gateway");
    },
    interrupt: async () => { calls.interrupt += 1; },
    compress: async () => { calls.compress += 1; },
    close: () => { },
    // test helpers
    emit(event) { for (const fn of [...wire]) fn(event); },
    emitFailure(error) { for (const fn of [...failures]) fn(error); },
    settlePrompt() { const r = promptDeferreds.shift(); if (r) r(); },
    _sessionId: () => sid,
    _calls: calls,
  };
  return client;
}

function makeRuntimeInfo() {
  return {
    systemPrompt: () => undefined,
    sessionTitle: () => undefined,
    routeContext: async () => ({ provider: "hermes", model: "m1" }),
    session: { cwd: "/tmp", resumeStoredSessionId: null },
  };
}

function makeUserMessage(text) {
  return createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
}

function types(events) {
  return events.map((e) => e.type);
}

test("fixture replay: wire sequence → DSH event ordering + stream records + usage", async () => {
  const session = makeFakeSession();
  const client = makeFakeClient();
  const agent = new HermesAgent(new Context(), "s1", { provider: "hermes" }, session, client, undefined, makeRuntimeInfo());

  agent.send(makeUserMessage("hi"), "next-turn", true);
  await delay(10);

  const pre = types(session.events);
  assert.ok(pre.includes("agent-preset/selected"), "first-turn preset stamp");
  assert.ok(pre.includes("turn/start"), "turn/start appended");
  assert.ok(pre.includes("request/context"), "request/context appended");
  assert.ok(pre.includes("user/message"), "user/message appended");
  assert.equal(client._calls.prompt.length, 1, "prompt dispatched once");
  assert.equal(client._calls.prompt[0], "hi");

  // replay the projected wire sequence
  client.emit({ type: "agent_start" });
  client.emit({ type: "turn_start" });
  client.emit({ type: "message_start", message: { role: "assistant", content: [] } });
  client.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" } });
  client.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hello" }] }, usage: { input: 10, output: 2, reasoning: 1 } });
  client.emit({ type: "turn_end", data: { status: "complete" } });
  client.emit({ type: "agent_end" });

  const t = types(session.events);
  const idx = (x) => t.indexOf(x);
  assert.ok(idx("turn/start") >= 0 && idx("user/message") > idx("turn/start"));
  assert.ok(idx("step/start") > idx("user/message"), "step/start after user/message");
  assert.ok(idx("assistant/message") > idx("step/start"), "assistant/message after step/start");
  assert.ok(idx("step/end") > idx("assistant/message"), "step/end after assistant/message");
  assert.ok(idx("turn/end") > idx("step/end"), "turn/end closes last");

  const assistant = session.events.find((e) => e.type === "assistant/message");
  assert.ok(Array.isArray(assistant.data.stream) && assistant.data.stream.length >= 1, "stream records embedded");
  assert.deepEqual(assistant.data.usage, { inputTokens: 10, outputTokens: 2, totalTokens: 12, reasoningTokens: 1 });

  const turnEnd = session.events.find((e) => e.type === "turn/end");
  assert.equal(turnEnd.data.reason.kind, "completed");
  assert.equal(agent.status, "idle");
});

test("prompt-guard: delivery while turnOpen queues followUp, flushed at idle", async () => {
  const session = makeFakeSession();
  const client = makeFakeClient();
  const agent = new HermesAgent(new Context(), "s1", { provider: "hermes" }, session, client, undefined, makeRuntimeInfo());

  agent.send(makeUserMessage("one"), "next-turn", true);
  await delay(10);
  assert.equal(client._calls.prompt.length, 1);
  assert.equal(session.events.filter((e) => e.type === "turn/start").length, 1);

  // second delivery while the turn is open → queued followUp (not dispatched)
  agent.send(makeUserMessage("two"), "next-turn", true);
  await delay(10);
  assert.equal(client._calls.prompt.length, 1, "followUp parked, not submitted while busy");
  assert.equal(session.events.filter((e) => e.type === "turn/start").length, 1);

  // close the turn (wire terminal) and settle the prompt → followUp flushes
  client.emit({ type: "agent_start" });
  client.emit({ type: "turn_start" });
  client.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "x" }] } });
  client.emit({ type: "turn_end" });
  client.emit({ type: "agent_end" });
  client.settlePrompt();
  await delay(10);

  assert.equal(session.events.filter((e) => e.type === "turn/start").length, 2, "followUp opened a fresh turn");
  assert.equal(client._calls.prompt.length, 2);
  assert.equal(client._calls.prompt[1], "two");
});

test("steer fallback: gateway steer rejection → plain prompt", async () => {
  const session = makeFakeSession();
  const client = makeFakeClient({ steerRejects: true });
  const agent = new HermesAgent(new Context(), "s1", { provider: "hermes" }, session, client, undefined, makeRuntimeInfo());

  // park a steer entry via inject (wakeup=false) while idle
  agent.inject(makeUserMessage("steer-me"));
  assert.equal(client._calls.steer.length, 0, "steer parked until agent_start");

  client.emit({ type: "agent_start" });
  await delay(10);

  assert.equal(client._calls.steer.length, 1, "steer dispatched at agent_start");
  assert.equal(client._calls.prompt.length, 1, "steer rejection fell back to a plain prompt");
  assert.equal(client._calls.prompt[0], "steer-me");
});

test("turn deadline: never-settling prompt → interrupt + turn/end error", async () => {
  process.env.HERMES_TURN_DEADLINE_MS = "60";
  const { HermesAgent: DeadlinedAgent } = await import(`../dist/agent.js?deadline=${Date.now()}`);
  const session = makeFakeSession();
  const client = makeFakeClient({ neverSettle: true });
  const agent = new DeadlinedAgent(new Context(), "s1", { provider: "hermes" }, session, client, undefined, makeRuntimeInfo());

  agent.send(makeUserMessage("hi"), "next-turn", true);
  await delay(10);
  assert.equal(session.events.filter((e) => e.type === "turn/start").length, 1);
  assert.equal(client._calls.prompt.length, 1);

  // wait past the 60ms deadline
  await delay(200);

  assert.equal(client._calls.interrupt, 1, "deadline interrupts the gateway turn");
  const turnEnd = session.events.find((e) => e.type === "turn/end");
  assert.ok(turnEnd, "turn/end appended by the deadline");
  assert.equal(turnEnd.data.reason.kind, "error");
  assert.equal(agent.status, "idle");

  delete process.env.HERMES_TURN_DEADLINE_MS;
});

test("late terminal after a closed turn never appends surface events (I1 guard)", async () => {
  process.env.HERMES_TURN_DEADLINE_MS = "60";
  const { HermesAgent: DeadlinedAgent } = await import(`../dist/agent.js?late=${Date.now()}`);
  const session = makeFakeSession();
  const client = makeFakeClient({ neverSettle: true });
  const agent = new DeadlinedAgent(new Context(), "s1", { provider: "hermes" }, session, client, undefined, makeRuntimeInfo());

  agent.send(makeUserMessage("hi"), "next-turn", true);
  await delay(10);
  await delay(200); // deadline fires → turn/end error
  const count = () => session.events.filter((e) => e.type === "assistant/message").length;
  assert.equal(count(), 0);

  // a late message_end (the gateway settling after interrupt) must be a no-op
  client.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "late" }] }, usage: { input: 1, output: 1 } });
  client.emit({ type: "turn_end", data: { status: "interrupted" } });
  client.emit({ type: "agent_end" });
  assert.equal(count(), 0, "late assistant/message after turn/end is impossible");

  delete process.env.HERMES_TURN_DEADLINE_MS;
});

// ─────────────────────────────────────────────────────────────────────────────
// M1 (2026-09-17): session/title mirror + todo/write + resume self-heal
// ─────────────────────────────────────────────────────────────────────────────

test("session_title wire event → session/title mirror (provider source, deduped, fail-soft)", async () => {
  const session = makeFakeSession();
  const client = makeFakeClient();
  const agent = new HermesAgent(new Context(), "s1", { provider: "hermes" }, session, client, undefined, makeRuntimeInfo());

  client.emit({ type: "session_title", name: "Reply with exactly: ok" });
  client.emit({ type: "session_title", name: "Reply with exactly: ok" }); // duplicate → dropped
  client.emit({ type: "session_title", name: "Better title" });
  client.emit({ type: "session_title", name: "" }); // empty → dropped
  client.emit({ type: "session_title" }); // missing name → dropped

  const titles = session.events.filter((e) => e.type === "session/title");
  assert.equal(titles.length, 2, "empty and duplicate titles are ignored");
  assert.deepEqual(titles[0].data, { title: "Reply with exactly: ok", messageSeqs: [], source: { kind: "provider", provider: "hermes" } });
  assert.deepEqual(titles[1].data.title, "Better title");
  void agent;
});

test("todo_updated wire event → log-only todo/write whole-list snapshot (open turn only)", async () => {
  const session = makeFakeSession();
  const client = makeFakeClient();
  const agent = new HermesAgent(new Context(), "s1", { provider: "hermes" }, session, client, undefined, makeRuntimeInfo());

  // No open turn yet → the invariant-gated write is skipped.
  client.emit({ type: "todo_updated", todos: [{ content: "early", status: "pending" }] });
  assert.equal(session.events.filter((e) => e.type === "todo/write").length, 0, "no todo/write outside an open turn");

  // Open a turn, then deliver the snapshot mid-turn.
  agent.send(makeUserMessage("hi"), "next-turn", true);
  await delay(10);
  client.emit({ type: "turn_start" });
  client.emit({ type: "todo_updated", todos: [{ content: "read the plan", status: "in_progress" }, { content: "write tests", status: "pending" }] });
  client.emit({ type: "todo_updated", todos: [{ content: "read the plan", status: "completed" }] }); // latest wins on replay
  const writes = session.events.filter((e) => e.type === "todo/write");
  assert.equal(writes.length, 2, "every snapshot appends (latest-wins log-only semantics)");
  assert.deepEqual(writes[0].data.todos, [
    { content: "read the plan", status: "in_progress" },
    { content: "write tests", status: "pending" },
  ]);
  assert.deepEqual(writes[1].data.todos, [{ content: "read the plan", status: "completed" }]);
  // no surfaceOp on todo/write (log-only, upstream tool-todo contract)
  assert.equal(writes[0].surfaceOp, undefined);
  void agent;
});

test("self-heal (ruling 4): a client-terminal failure triggers the full idle-exit dispose", async () => {
  const session = makeFakeSession();
  const client = makeFakeClient({ usable: false });
  let disposeCalls = 0;
  const agent = new HermesAgent(new Context(), "s1", { provider: "hermes" }, session, client, () => { disposeCalls += 1; }, makeRuntimeInfo());

  // Terminal failure arrives while NO turn is open (the wedge shape: the
  // reaper/stale client dies between prompts).
  client.emitFailure(new Error("hermes gateway client closed"));
  await delay(10);
  assert.equal(disposeCalls, 1, "idle-exit dispose fired exactly once");

  // ... and again mid-turn: the open turn closes with the classified code first.
  const session2 = makeFakeSession();
  const client2 = makeFakeClient({ usable: false });
  let dispose2 = 0;
  const agent2 = new HermesAgent(new Context(), "s2", { provider: "hermes" }, session2, client2, () => { dispose2 += 1; }, makeRuntimeInfo());
  agent2.send(makeUserMessage("hi"), "next-turn", true);
  await delay(10);
  client2.emit({ type: "agent_start" });
  client2.emit({ type: "turn_start" });
  client2.emitFailure(new Error("gateway child exited (code=1); stderr tail:\nboom"));
  await delay(10);
  const turnEnd = session2.events.find((e) => e.type === "turn/end");
  assert.equal(turnEnd.data.reason.kind, "error");
  assert.equal(turnEnd.data.reason.error.code, "GATEWAY_CRASH");
  assert.equal(dispose2, 1, "client-terminal failure mid-turn disposes too");
  void agent;
});

test("self-heal does NOT fire for ordinary per-turn failures (client still usable)", async () => {
  const session = makeFakeSession();
  const client = makeFakeClient(); // usable
  let disposeCalls = 0;
  const agent = new HermesAgent(new Context(), "s1", { provider: "hermes" }, session, client, () => { disposeCalls += 1; }, makeRuntimeInfo());

  agent.send(makeUserMessage("hi"), "next-turn", true);
  await delay(10);
  client.emit({ type: "agent_start" });
  client.emit({ type: "turn_start" });
  client.emitFailure(new Error("hermes gateway error event: provider hiccup"));
  await delay(10);
  const turnEnd = session.events.find((e) => e.type === "turn/end");
  assert.equal(turnEnd.data.reason.error.code, "UNKNOWN", "ordinary failure stays unclassified");
  assert.equal(disposeCalls, 0, "usable client → no dispose");
});

test("cold start against a dead client classifies CLIENT_CLOSED and self-heals", async () => {
  const session = makeFakeSession();
  const client = makeFakeClient({ usable: false });
  client.ensureStarted = async () => { throw new Error("hermes gateway client closed"); };
  let disposeCalls = 0;
  const agent = new HermesAgent(new Context(), "s1", { provider: "hermes" }, session, client, () => { disposeCalls += 1; }, makeRuntimeInfo());

  agent.send(makeUserMessage("hi"), "next-turn", true);
  await delay(10);
  const turnEnd = session.events.find((e) => e.type === "turn/end");
  assert.ok(turnEnd, "failed cold start synthesizes the failed turn");
  assert.equal(turnEnd.data.reason.error.code, "CLIENT_CLOSED");
  assert.equal(disposeCalls, 1, "the next prompt re-resumes a fresh client (host-side)");
});

test("routeContext receives the {provider, model} selection (real-slug threading)", async () => {
  const seen = [];
  const runtimeInfo = {
    ...makeRuntimeInfo(),
    routeContext: async (selection) => {
      seen.push(selection);
      return { provider: selection.provider ?? "deepseek", model: selection.model ?? "deepseek-v4-pro" };
    },
  };
  const session = makeFakeSession();
  const client = makeFakeClient();
  const agent = new HermesAgent(new Context(), "s1", { provider: "deepseek", model: "deepseek-v4-pro" }, session, client, undefined, runtimeInfo);
  agent.send(makeUserMessage("hi"), "next-turn", true);
  await delay(10);
  assert.ok(seen.length >= 1, "routeContext consulted");
  assert.deepEqual(seen[0], { provider: "deepseek", model: "deepseek-v4-pro" });
  const requestContext = session.events.find((e) => e.type === "request/context");
  assert.equal(requestContext.data.provider, "deepseek");
  assert.equal(requestContext.data.model, "deepseek-v4-pro");
});

// ---- handshake retry (2026-09-18 ruling: ~3 attempts, transient only) ----

test("session.resume retries transient failures and proceeds on the third attempt", async () => {
  const session = makeFakeSession();
  const client = makeFakeClient({ resumeFailures: [
    new Error("timeout: session.resume"),
    new Error("timeout: session.resume"),
  ] });
  const runtime = makeRuntimeInfo();
  runtime.session = { cwd: "/tmp", resumeStoredSessionId: "gw-stored-1" };
  const agent = new HermesAgent(new Context(), "s1", { provider: "hermes" }, session, client, undefined, runtime);

  agent.send(makeUserMessage("hi"), "next-turn", true);
  await delay(20);

  assert.equal(client._calls.resumeSession.length, 3, "two transient failures retried, third succeeded");
  assert.equal(client._calls.prompt.length, 1, "the turn proceeded after the handshake");
  assert.ok(types(session.events).includes("turn/start"));
});

test("session.resume fails fast on the third transient failure (bounded)", async () => {
  const session = makeFakeSession();
  const client = makeFakeClient({ resumeFailures: [
    new Error("timeout: session.resume"),
    new Error("timeout: session.resume"),
    new Error("timeout: session.resume"),
  ] });
  const runtime = makeRuntimeInfo();
  runtime.session = { cwd: "/tmp", resumeStoredSessionId: "gw-stored-2" };
  const agent = new HermesAgent(new Context(), "s1", { provider: "hermes" }, session, client, undefined, runtime);

  agent.send(makeUserMessage("hi"), "next-turn", true);
  await delay(20);

  assert.equal(client._calls.resumeSession.length, 3, "exactly 3 attempts — never more");
  const turnEnd = session.events.find((e) => e.type === "turn/end");
  assert.ok(turnEnd !== undefined, "the turn failed closed");
  assert.equal(turnEnd.data.reason.error?.code, "UNKNOWN");
});

test("session.resume never retries a gateway RPC rejection (the gateway answered)", async () => {
  const { GatewayRpcError } = await import("../dist/hermes-client.js");
  const session = makeFakeSession();
  const client = makeFakeClient({ resumeFailures: [new GatewayRpcError("session.resume", "gone", 4001)] });
  const runtime = makeRuntimeInfo();
  runtime.session = { cwd: "/tmp", resumeStoredSessionId: "gw-stored-3" };
  const agent = new HermesAgent(new Context(), "s1", { provider: "hermes" }, session, client, undefined, runtime);

  agent.send(makeUserMessage("hi"), "next-turn", true);
  await delay(20);

  assert.equal(client._calls.resumeSession.length, 1, "RPC rejection = permanent, single attempt");
  const turnEnd = session.events.find((e) => e.type === "turn/end");
  assert.equal(turnEnd?.data.reason.error?.code, "NATIVE_SESSION_GONE");
});
