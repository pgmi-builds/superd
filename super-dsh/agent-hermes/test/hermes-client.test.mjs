// Task 3 TDD (RED first): HermesGatewayClient — the reusable gateway client seam.
//
// All child-process behavior is faked through the GatewayProcessFactory seam
// (mirroring agent-codex's setCodexFactory injection): no real python child is
// ever spawned here. Frame shapes come from the Task 1 live capture
// (test/fixtures/gateway-events.sample.json, schema agent-hermes/spike-events@1)
// and the gateway source pins:
//   - event envelope  {jsonrpc,method:"event",params:{type,session_id?,payload?}}
//     (server.py _event_frame; gateway.ready has NO session_id, message.start
//     carries NO payload key)
//   - responses       {jsonrpc,id,result|error:{code,message}} — id echoed exactly
//   - approval payload server.py:3036 _approval_request_payload over
//     tools/approval.py _ApprovalEntry/pending_data (request_id uuid4-hex
//     setdefault, command redacted, description, pattern_key(s),
//     allow_session/allow_permanent, choices injected by the builder)
//   - approval.respond params {session_id, choice, request_id?}
//     (methods_prompt.py:1881 — choice default "deny", request_id optional)
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { readFileSync } from "node:fs";
import {
  HermesGatewayClient,
  setGatewayFactory,
  resolveHermesPython,
  GatewayRpcError,
} from "../dist/hermes-client.js";

const FIXTURE = JSON.parse(
  readFileSync(join(new URL(".", import.meta.url).pathname, "fixtures", "gateway-events.sample.json"), "utf8"),
);

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Fake child process (duck-typed GatewayProcessLike)
// ---------------------------------------------------------------------------

class FakeStdin extends Writable {
  constructor() {
    super();
    this.requests = [];
  }

  _write(chunk, _enc, cb) {
    for (const line of chunk.toString().split("\n")) {
      if (!line.trim()) continue;
      try {
        this.requests.push(JSON.parse(line));
      } catch {
        this.requests.push({ malformed: line });
      }
    }
    cb();
  }

  get lastRequest() {
    return this.requests[this.requests.length - 1];
  }
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new FakeStdin();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.killed = false;
    this.killSignals = [];
    this._exited = false;
  }

  kill(signal = "SIGTERM") {
    this.killSignals.push(signal);
    this.killed = true;
    this.emitExit(null, signal);
  }

  emitExit(code, signal) {
    if (this._exited) return;
    this._exited = true;
    this.exitCode = code;
    this.emit("exit", code, signal);
  }

  emitLine(obj) {
    this.stdout.write(`${JSON.stringify(obj)}\n`);
  }

  /** params.session_id omitted when sessionId is undefined (message.start parity). */
  emitEvent(type, sessionId, payload) {
    const params = { type };
    if (sessionId !== undefined) params.session_id = sessionId;
    if (payload !== undefined) params.payload = payload;
    this.emitLine({ jsonrpc: "2.0", method: "event", params });
  }

  respond(id, result) {
    this.emitLine({ jsonrpc: "2.0", id, result });
  }

  respondError(id, code, message) {
    this.emitLine({ jsonrpc: "2.0", id, error: { code, message } });
  }

  get lastRequest() {
    return this.stdin.lastRequest;
  }
}

let lastChild = null;
let factoryCalls = [];

function installFake() {
  setGatewayFactory((opts) => {
    factoryCalls.push(opts);
    lastChild = new FakeChild();
    return lastChild;
  });
}

function restoreFactory() {
  setGatewayFactory(null);
}

/** Spawn + fake gateway.ready. Returns the client (no session yet). */
async function startReady(spawnOpts = {}) {
  const client = HermesGatewayClient.spawn(spawnOpts);
  const readyP = client.ensureStarted();
  await delay(5);
  lastChild.emitEvent("gateway.ready", undefined, { change_events: true });
  await readyP;
  return client;
}

/** startReady + session.create answered with live sid "s1". */
async function withSession(spawnOpts = {}) {
  const client = await startReady(spawnOpts);
  const createP = client.createSession({ cwd: "/w/proj", title: "dsh-aw unit" });
  await delay(5);
  assert.equal(lastChild.lastRequest.method, "session.create");
  lastChild.respond(lastChild.lastRequest.id, {
    session_id: "s1",
    stored_session_id: "k1",
    message_count: 0,
    messages: [],
    info: { model: "deepseek-v4-pro", cwd: "/w/proj" },
  });
  const session = await createP;
  return { client, child: lastChild, session };
}

/** Replay every EVENT frame of the fixture turn (index order) into the child. */
async function replayFixtureTurn(child, sid = "s1") {
  for (const rec of FIXTURE.turn) {
    if (rec.frame.method !== "event") continue;
    // rewrite session_id onto our fake sid so the demux filter matches
    child.emitEvent(rec.frame.params.type, rec.frame.params.session_id === "" ? "" : sid, rec.frame.params.payload);
    await delay(2);
  }
}

// Hand-built approval payload — exact shape of server.py:3036
// _approval_request_payload over tools/approval.py pending_data (~5783/5328)
// plus the _ApprovalEntry request_id setdefault (~2827). NEVER triggered live.
const APPROVAL_PAYLOAD = {
  command: "rm -rf /tmp/hermes-approval-probe",
  pattern_key: "bash:rm-rf",
  pattern_keys: ["bash:rm-rf"],
  description: "Run a destructive rm command",
  allow_session: true,
  allow_permanent: true,
  request_id: "req-1234abcd",
  choices: ["once", "session", "always", "deny"],
};

// ---------------------------------------------------------------------------
// spawn seam: env hygiene + python resolution
// ---------------------------------------------------------------------------

test("spawn: python resolution order and child env hygiene (never HERMES_HOME)", async () => {
  installFake();
  try {
    const prevPython = process.env.AW_HERMES_PYTHON;
    const prevRoot = process.env.AW_HERMES_ROOT;
    process.env.AW_HERMES_PYTHON = "/custom/python";
    process.env.AW_HERMES_ROOT = "/custom/root";
    const client = HermesGatewayClient.spawn({
      cwd: "/w/cwd",
      env: { PATH: "/usr/bin", HERMES_HOME: "/must-not-survive", HERMES_TUI_GATEWAY_URL: "http://x", HERMES_TUI_SIDECAR_URL: "http://y", PYTHONPATH: "/prev" },
    });
    assert.equal(factoryCalls.length, 1);
    const call = factoryCalls[0];
    assert.equal(call.command, "/custom/python"); // AW_HERMES_PYTHON wins
    assert.deepEqual(call.args, ["-m", "tui_gateway.entry"]);
    assert.equal(call.cwd, "/w/cwd");
    assert.equal(call.env.HERMES_HOME, undefined); // NEVER set / always stripped
    assert.equal(call.env.HERMES_TUI_GATEWAY_URL, undefined);
    assert.equal(call.env.HERMES_TUI_SIDECAR_URL, undefined);
    assert.equal(call.env.HERMES_PYTHON_SRC_ROOT, "/custom/root"); // spike-proven additions
    assert.equal(call.env.PYTHONPATH, "/custom/root:/prev"); // root prepended
    assert.equal(call.env.PATH, "/usr/bin"); // full pass-through of the base env
    client.close();
    delete process.env.AW_HERMES_PYTHON;
    delete process.env.AW_HERMES_ROOT;
    if (prevPython !== undefined) process.env.AW_HERMES_PYTHON = prevPython;
    if (prevRoot !== undefined) process.env.AW_HERMES_ROOT = prevRoot;
  } finally {
    restoreFactory();
  }
});

test("resolveHermesPython: venv before .venv before PATH python3", () => {
  const prev = process.env.AW_HERMES_PYTHON;
  delete process.env.AW_HERMES_PYTHON;
  try {
    const dir = mkdtempSync(join(tmpdir(), "hermes-py-"));
    try {
      // neither candidate → PATH python3
      assert.equal(resolveHermesPython(dir), "python3");
      // only .venv → .venv wins over python3
      mkdirSync(join(dir, ".venv/bin"), { recursive: true });
      writeFileSync(join(dir, ".venv/bin/python"), "#!/bin/sh\n");
      assert.equal(resolveHermesPython(dir), join(dir, ".venv/bin/python"));
      // venv exists too → venv wins (brief-pinned order)
      mkdirSync(join(dir, "venv/bin"), { recursive: true });
      writeFileSync(join(dir, "venv/bin/python"), "#!/bin/sh\n");
      assert.equal(resolveHermesPython(dir), join(dir, "venv/bin/python"));
      // explicit override wins over everything
      process.env.AW_HERMES_PYTHON = "/opt/special/python";
      assert.equal(resolveHermesPython(dir), "/opt/special/python");
      delete process.env.AW_HERMES_PYTHON;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    if (prev !== undefined) process.env.AW_HERMES_PYTHON = prev;
  }
});

// ---------------------------------------------------------------------------
// startup sequencing
// ---------------------------------------------------------------------------

test("ready sequencing: requests queue until gateway.ready, then flush in order", async () => {
  installFake();
  try {
    const client = HermesGatewayClient.spawn({});
    const child = lastChild;
    const createP = client.createSession({ cwd: "/w" });
    await delay(5);
    assert.equal(child.stdin.requests.length, 0); // queued — nothing written pre-ready
    child.emitEvent("gateway.ready", undefined, { change_events: true });
    await delay(5);
    assert.equal(child.stdin.requests.length, 1); // flushed after ready
    assert.equal(child.stdin.requests[0].method, "session.create");
    child.respond(child.stdin.requests[0].id, { session_id: "s1" });
    const session = await createP;
    assert.equal(session.session_id, "s1");
    // ensureStarted is idempotent (same settled promise)
    await client.ensureStarted();
    client.close();
  } finally {
    restoreFactory();
  }
});

test("ready timeout: ensureStarted rejects, queued request rejects, child killed, onFailure once", async () => {
  installFake();
  try {
    const failures = [];
    const client = HermesGatewayClient.spawn({ readyTimeoutMs: 30 });
    client.onFailure((e) => failures.push(e));
    const createP = client.createSession({ cwd: "/w" });
    await assert.rejects(client.ensureStarted(), /gateway\.ready/);
    await assert.rejects(createP, /gateway\.ready/);
    assert.equal(failures.length, 1);
    assert.ok(lastChild.killSignals.includes("SIGTERM"));
    // further calls fail with the recorded failure
    await assert.rejects(client.createSession({ cwd: "/w" }), /gateway\.ready/);
    await delay(5); // let the exit echo settle — no double failure
    assert.equal(failures.length, 1);
  } finally {
    restoreFactory();
  }
});

// ---------------------------------------------------------------------------
// request/response correlation
// ---------------------------------------------------------------------------

test("id correlation: concurrent responses resolve their own request, out of order", async () => {
  installFake();
  try {
    const { client, child } = await withSession();
    const usageP = client.usage();
    const statusP = client.status();
    await delay(5);
    const [usageReq, statusReq] = child.stdin.requests.slice(-2);
    assert.equal(usageReq.method, "session.usage");
    assert.equal(statusReq.method, "session.status");
    child.respond(statusReq.id, { output: "status" }); // second request first
    child.respond(usageReq.id, { calls: 0 });
    assert.deepEqual(await usageP, { calls: 0 });
    assert.deepEqual(await statusP, { output: "status" });
    client.close();
  } finally {
    restoreFactory();
  }
});

test("request timeout rejects; the late response is ignored (no unhandled rejection)", async () => {
  installFake();
  try {
    const { client, child } = await withSession({ requestTimeoutMs: 40 });
    const usageP = client.usage();
    await assert.rejects(usageP, /timeout: session\.usage/);
    const reqId = child.lastRequest.id;
    child.respond(reqId, { calls: 1 }); // late → unknown id → ignored
    child.emitLine({ jsonrpc: "2.0", id: "r999", result: {} }); // never-issued id → ignored
    await delay(10);
    // still usable after the ignored late frames
    const statusP = client.status();
    await delay(5);
    child.respond(child.lastRequest.id, { output: "ok" });
    assert.deepEqual(await statusP, { output: "ok" });
    client.close();
  } finally {
    restoreFactory();
  }
});

test("RPC error frames reject with code + method (GatewayRpcError)", async () => {
  installFake();
  try {
    const { client, child } = await withSession();
    const usageP = client.usage();
    await delay(5);
    child.respondError(child.lastRequest.id, 5072, "session storage unavailable");
    await assert.rejects(usageP, (err) => err instanceof GatewayRpcError && err.code === 5072 && /session\.usage/.test(err.message));
    client.close();
  } finally {
    restoreFactory();
  }
});

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

test("createSession: params shape (cwd/title/model/provider/cols) + single-session posture", async () => {
  installFake();
  try {
    const client = await startReady();
    const createP = client.createSession({ cwd: "/w/proj", title: "dsh-aw t", model: "deepseek-v4-pro", provider: "deepseek" });
    await delay(5);
    const req = lastChild.lastRequest;
    assert.equal(req.method, "session.create");
    assert.deepEqual(req.params, { cwd: "/w/proj", title: "dsh-aw t", model: "deepseek-v4-pro", provider: "deepseek", cols: 120 });
    lastChild.respond(req.id, { session_id: "s1", stored_session_id: "k1", message_count: 0 });
    const session = await createP;
    assert.equal(session.session_id, "s1");
    assert.equal(session.stored_session_id, "k1");
    assert.equal(client.sessionId, "s1", "live (ephemeral) id captured");
    assert.equal(client.storedSessionId, "k1", "durable id captured on the client");
    // single-session client: a second create/resume must fail loudly
    await assert.rejects(client.createSession({ cwd: "/w" }), /single-session/);
    await assert.rejects(client.resumeSession("k1"), /single-session/);
    client.close();
  } finally {
    restoreFactory();
  }
});

test("resumeSession: replay window drops our-session events until the response lands", async () => {
  installFake();
  try {
    const client = await startReady();
    const wire = [];
    const off = client.on((e) => wire.push(e));
    const resumeP = client.resumeSession("k-old");
    await delay(5);
    assert.equal(lastChild.lastRequest.method, "session.resume");
    assert.deepEqual(lastChild.lastRequest.params, { session_id: "k-old", cols: 120 });
    // events arriving BEFORE the resume response are replay → dropped
    lastChild.emitEvent("message.delta", "s9", { text: "replayed" });
    lastChild.emitEvent("message.start", "s9");
    await delay(10);
    assert.equal(wire.length, 0);
    lastChild.respond(lastChild.lastRequest.id, { session_id: "s9", stored_session_id: "k-old", message_count: 0, messages: [] });
    const session = await resumeP;
    assert.equal(session.session_id, "s9");
    assert.equal(client.sessionId, "s9", "resume ADOPTS the newly minted live id");
    assert.equal(client.storedSessionId, "k-old", "durable id captured on resume");
    // after the response, events for the (possibly reminted) live sid flow
    lastChild.emitEvent("message.start", "s9");
    await delay(5);
    lastChild.emitEvent("message.delta", "s9", { text: "live" });
    await delay(5);
    assert.deepEqual(wire.map((e) => e.type), ["agent_start", "turn_start", "message_start", "message_update"]);
    off();
    client.close();
  } finally {
    restoreFactory();
  }
});

test("resumeSession: 4001/4006 RPC errors reject (fail closed)", async () => {
  installFake();
  try {
    const client = await startReady();
    const resumeP = client.resumeSession("nope");
    await delay(5);
    lastChild.respondError(lastChild.lastRequest.id, 4001, "session not found");
    await assert.rejects(resumeP, (err) => err instanceof GatewayRpcError && err.code === 4001);
    // empty id → client-side refusal before any wire traffic
    await assert.rejects(client.resumeSession(""), /session id/);
    client.close();
  } finally {
    restoreFactory();
  }
});

// ---------------------------------------------------------------------------
// event demux + projector feeding (fixture turn)
// ---------------------------------------------------------------------------

test("fixture turn: demux + projection + prompt resolves on the settled pair", async () => {
  installFake();
  try {
    const { client, child } = await withSession();
    const wire = [];
    const off = client.on((e) => wire.push(e));
    const promptP = client.prompt("Reply with exactly: ok");
    await delay(5);
    const submitReq = child.lastRequest;
    assert.equal(submitReq.method, "prompt.submit");
    assert.deepEqual(submitReq.params, { session_id: "s1", text: "Reply with exactly: ok" });
    child.respond(submitReq.id, { status: "streaming" });
    // foreign-session and session-less frames never project
    child.emitEvent("message.delta", "other-session", { text: "x" });
    child.emitEvent("sessions.changed", "", {});
    await replayFixtureTurn(child);
    await promptP; // message.complete → session.info(running=false) pair
    off();
    assert.deepEqual(
      wire.map((e) => e.type),
      // The fixture's two session.title frames now project (session_title) —
      // the agent mirrors them as session/title; the client just forwards.
      ["agent_start", "turn_start", "message_start", "session_title", "session_title", "message_update", "message_end", "turn_end", "agent_end"],
    );
    const messageEnd = wire[6];
    // gateway did NOT re-attach reasoning (fixture fact) → the client's
    // accumulated thinking buffer is injected into the projected payload
    assert.deepEqual(messageEnd.message.content, [
      { type: "text", text: "ok" },
      { type: "thinking", thinking: "( •_•)>⌐■-■ analyzing..." },
    ]);
    const usage = FIXTURE.turn["11"].frame.params.payload.usage;
    assert.deepEqual(messageEnd.usage, usage); // fixture usage present → carried verbatim
    assert.deepEqual(wire[7], { type: "turn_end", data: { usage, status: "complete" } });
    // guard released after settle
    const p2 = client.prompt("second");
    await delay(5);
    assert.equal(child.lastRequest.method, "prompt.submit");
    child.respond(child.lastRequest.id, { status: "streaming" });
    child.emitEvent("message.start", "s1");
    child.emitEvent("message.complete", "s1", { text: "2", status: "complete" });
    child.emitEvent("session.info", "s1", { running: false });
    await p2;
    client.close();
  } finally {
    restoreFactory();
  }
});

test("thinking accumulation: gateway reasoning (when present) wins over the buffer", async () => {
  installFake();
  try {
    const { client, child } = await withSession();
    const wire = [];
    const off = client.on((e) => wire.push(e));
    const promptP = client.prompt("q");
    await delay(5);
    child.respond(child.lastRequest.id, { status: "streaming" });
    child.emitEvent("message.start", "s1");
    child.emitEvent("thinking.delta", "s1", { text: "client buffer " });
    child.emitEvent("reasoning.delta", "s1", { text: "should be ignored" });
    child.emitEvent("message.complete", "s1", { text: "a", reasoning: "authoritative", status: "complete" });
    child.emitEvent("session.info", "s1", { running: false });
    await promptP;
    off();
    const messageEnd = wire.find((e) => e.type === "message_end");
    assert.deepEqual(messageEnd.message.content, [
      { type: "text", text: "a" },
      { type: "thinking", thinking: "authoritative" },
    ]);
    client.close();
  } finally {
    restoreFactory();
  }
});

test("orphan tool.complete synthesizes the missing tool_execution_start", async () => {
  installFake();
  try {
    const { client, child } = await withSession();
    const wire = [];
    const off = client.on((e) => wire.push(e));
    const promptP = client.prompt("q");
    await delay(5);
    child.respond(child.lastRequest.id, { status: "streaming" });
    child.emitEvent("message.start", "s1");
    // tool.complete with NO preceding tool.start → synthesize the start
    child.emitEvent("tool.complete", "s1", { tool_id: "t9", name: "read_file", args: { path: "/x" }, result: "ok", duration_s: 0.4 });
    // a normal pair afterwards stays 1:1
    child.emitEvent("tool.start", "s1", { tool_id: "t2", name: "terminal", context: "npm t" });
    child.emitEvent("tool.complete", "s1", { tool_id: "t2", name: "terminal", args: {}, result: "done" });
    child.emitEvent("message.complete", "s1", { text: "done", status: "complete" });
    child.emitEvent("session.info", "s1", { running: false });
    await promptP;
    off();
    const kinds = wire.filter((e) => e.type.startsWith("tool_execution"));
    assert.deepEqual(
      kinds.map((e) => `${e.type}:${e.toolCallId}`),
      ["tool_execution_start:t9", "tool_execution_end:t9", "tool_execution_start:t2", "tool_execution_end:t2"],
    );
    // the synthesized start is built from the complete payload via the projector
    assert.deepEqual(kinds[0], {
      type: "tool_execution_start",
      toolCallId: "t9",
      toolName: "read_file",
      args: { path: "/x" },
      argumentsJson: '{"path":"/x"}',
    });
    client.close();
  } finally {
    restoreFactory();
  }
});

// ---------------------------------------------------------------------------
// prompt guard + turn failure paths
// ---------------------------------------------------------------------------

test("prompt guard: busy rejection while a turn is in flight; RPC error releases the guard", async () => {
  installFake();
  try {
    const { client, child } = await withSession();
    const p1 = client.prompt("first");
    // second prompt rejected immediately — before any turn, client-side only
    await assert.rejects(client.prompt("second"), /busy/);
    // gateway refuses the submit BEFORE any turn (slot-claim 4090) → p1 rejects,
    // guard released
    await delay(5);
    child.respondError(child.lastRequest.id, 4090, "Hermes could not safely reserve this session. Try again.");
    await assert.rejects(p1, (err) => err instanceof GatewayRpcError && err.code === 4090);
    // non-streaming ack → protocol failure, guard released
    const p2 = client.prompt("weird ack");
    await delay(5);
    child.respond(child.lastRequest.id, { voice_stopped: true });
    await assert.rejects(p2, /ack/);
    // guard is free again — accept and settle normally
    const p3 = client.prompt("good");
    await delay(5);
    child.respond(child.lastRequest.id, { status: "streaming" });
    child.emitEvent("message.start", "s1");
    child.emitEvent("message.complete", "s1", { text: "ok", status: "complete" });
    child.emitEvent("session.info", "s1", { running: false });
    await p3;
    client.close();
  } finally {
    restoreFactory();
  }
});

test("prompt settles as a rejection on a gateway error event (before or during the turn)", async () => {
  installFake();
  try {
    const { client, child } = await withSession();
    const wire = [];
    const off = client.on((e) => wire.push(e));
    // error event BEFORE message.start (agent init failed) — projector sees no
    // open turn, but the client knows its turn is in flight → reject
    const p1 = client.prompt("q");
    await delay(5);
    child.respond(child.lastRequest.id, { status: "streaming" });
    child.emitEvent("error", "s1", { message: "agent init failed" });
    await assert.rejects(p1, /agent init failed/);
    // mid-turn error event (turn open) → agent_end on the wire + rejection
    const p2 = client.prompt("q2");
    await delay(5);
    child.respond(child.lastRequest.id, { status: "streaming" });
    child.emitEvent("message.start", "s1");
    child.emitEvent("error", "s1", { message: "boom mid-turn" });
    await assert.rejects(p2, /boom mid-turn/);
    assert.deepEqual(wire.map((e) => e.type), ["agent_start", "turn_start", "message_start", "agent_end"]);
    off();
    client.close();
  } finally {
    restoreFactory();
  }
});

// ---------------------------------------------------------------------------
// approval bridge
// ---------------------------------------------------------------------------

test("approval bridge: payload parsed per gateway source; listener answer sent via approval.respond", async () => {
  installFake();
  try {
    const { client, child } = await withSession();
    const wire = [];
    const off = client.on((e) => wire.push(e));
    const seen = [];
    client.onApproval(async (req) => {
      seen.push(req);
      return "always";
    });
    child.emitEvent("approval.request", "s1", APPROVAL_PAYLOAD);
    await delay(10);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].requestId, "req-1234abcd");
    assert.equal(seen[0].title, "Run a destructive rm command");
    assert.equal(seen[0].command, "rm -rf /tmp/hermes-approval-probe");
    assert.equal(seen[0].raw.choices[0], "once"); // raw payload verbatim
    const respondReq = child.lastRequest;
    assert.equal(respondReq.method, "approval.respond");
    assert.deepEqual(respondReq.params, { session_id: "s1", choice: "always", request_id: "req-1234abcd" });
    assert.equal(wire.length, 0); // approval.request never projects onto the wire
    off();
    client.close();
  } finally {
    restoreFactory();
  }
});

test("approval bridge: fail closed — missing listener / throw / timeout / void → deny", async () => {
  installFake();
  try {
    const { client, child } = await withSession({ approvalTimeoutMs: 30 });
    // missing listener → deny
    child.emitEvent("approval.request", "s1", { ...APPROVAL_PAYLOAD, request_id: "r-no-listener" });
    await delay(10);
    assert.deepEqual(child.lastRequest.params, { session_id: "s1", choice: "deny", request_id: "r-no-listener" });
    // listener throw → deny (unsubscribe between phases: the bridge dispatches
    // to the FIRST registered listener)
    const offThrow = client.onApproval(async () => {
      throw new Error("listener blew up");
    });
    child.emitEvent("approval.request", "s1", { ...APPROVAL_PAYLOAD, request_id: "r-throw" });
    await delay(10);
    offThrow();
    assert.deepEqual(child.lastRequest.params, { session_id: "s1", choice: "deny", request_id: "r-throw" });
    // listener too slow (30ms cap) → deny at the deadline, late answer ignored
    const offSlow = client.onApproval(async () => {
      await delay(300);
      return "once";
    });
    child.emitEvent("approval.request", "s1", { ...APPROVAL_PAYLOAD, request_id: "r-slow" });
    await delay(60);
    offSlow();
    assert.deepEqual(child.lastRequest.params, { session_id: "s1", choice: "deny", request_id: "r-slow" });
    // void answer → deny; invalid string → deny (3-value union only)
    const offVoid = client.onApproval(async () => undefined);
    child.emitEvent("approval.request", "s1", { ...APPROVAL_PAYLOAD, request_id: "r-void" });
    await delay(10);
    offVoid();
    assert.deepEqual(child.lastRequest.params, { session_id: "s1", choice: "deny", request_id: "r-void" });
    // payload without request_id (defensive — entry always setdefaults it) →
    // respond still goes out, FIFO oldest, no request_id key
    client.onApproval(async () => "once");
    child.emitEvent("approval.request", "s1", { command: "c", description: "d" });
    await delay(10);
    assert.deepEqual(child.lastRequest.params, { session_id: "s1", choice: "once" });
    await delay(300); // let the slow listener's late answer land — must not send again
    assert.equal(child.stdin.requests.filter((r) => r.method === "approval.respond").length, 5);
    client.close();
  } finally {
    restoreFactory();
  }
});

test("respondApproval: direct RPC (choice validated, request_id optional)", async () => {
  installFake();
  try {
    const { client, child } = await withSession();
    const p = client.respondApproval("req-xyz", "deny");
    await delay(5);
    assert.deepEqual(child.lastRequest.params, { session_id: "s1", choice: "deny", request_id: "req-xyz" });
    child.respond(child.lastRequest.id, { resolved: 1 });
    await p;
    await assert.rejects(client.respondApproval("req-xyz", "session"), /invalid approval choice/);
    client.close();
  } finally {
    restoreFactory();
  }
});

// ---------------------------------------------------------------------------
// RPC surface parity
// ---------------------------------------------------------------------------

test("steer/interrupt/compress/history/usage/status/modelOptions map onto gateway RPCs", async () => {
  installFake();
  try {
    const { client, child } = await withSession();
    const steerP = client.steer("go left");
    await delay(5);
    assert.deepEqual(child.lastRequest.params, { session_id: "s1", text: "go left" });
    child.respond(child.lastRequest.id, { status: "queued", text: "go left" });
    await steerP;
    // steer rejected by the gateway → throws
    const steer2 = client.steer("nope");
    await delay(5);
    child.respond(child.lastRequest.id, { status: "rejected", text: "nope" });
    await assert.rejects(steer2, /rejected/);
    const interruptP = client.interrupt();
    await delay(5);
    assert.equal(child.lastRequest.method, "session.interrupt");
    child.respond(child.lastRequest.id, { status: "interrupted" });
    await interruptP;
    const compressP = client.compress();
    await delay(5);
    assert.equal(child.lastRequest.method, "session.compress");
    child.respond(child.lastRequest.id, { status: "done" });
    await compressP;
    const historyP = client.history();
    await delay(5);
    assert.deepEqual(child.lastRequest.params, { session_id: "s1" });
    child.respond(child.lastRequest.id, { count: 2, messages: [] });
    assert.deepEqual(await historyP, { count: 2, messages: [] });
    const usageP = client.usage();
    await delay(5);
    child.respond(child.lastRequest.id, { calls: 0, input: 0, output: 0, total: 0 });
    assert.deepEqual(await usageP, { calls: 0, input: 0, output: 0, total: 0 });
    const statusP = client.status();
    await delay(5);
    child.respond(child.lastRequest.id, { output: "blob" });
    assert.deepEqual(await statusP, { output: "blob" });
    const modelsP = client.modelOptions();
    await delay(5);
    assert.deepEqual(child.lastRequest.params, {});
    child.respond(child.lastRequest.id, { providers: [], model: "m", provider: "p" });
    assert.deepEqual(await modelsP, { providers: [], model: "m", provider: "p" });
    client.close();
  } finally {
    restoreFactory();
  }
});

test("session-scoped RPCs before createSession fail fast (single-session posture)", async () => {
  installFake();
  try {
    const client = await startReady();
    await assert.rejects(client.prompt("x"), /no session/);
    await assert.rejects(client.usage(), /no session/);
    await assert.rejects(client.respondApproval("r", "deny"), /no session/);
    client.close();
  } finally {
    restoreFactory();
  }
});

// ---------------------------------------------------------------------------
// child exit + close
// ---------------------------------------------------------------------------

test("child exit: pending RPCs rejected, in-flight prompt rejected, onFailure fires once", async () => {
  installFake();
  try {
    const { client, child } = await withSession();
    const failures = [];
    client.onFailure((e) => failures.push(e));
    const usageP = client.usage();
    const promptP = client.prompt("never finishes");
    await delay(5);
    child.respond(child.lastRequest.id, { status: "streaming" });
    child.emitExit(1, null);
    await assert.rejects(usageP, /exited/);
    await assert.rejects(promptP, /exited/);
    assert.equal(failures.length, 1);
    // post-exit frames are inert
    child.emitEvent("message.start", "s1");
    child.emitLine({ jsonrpc: "2.0", id: "r77", result: {} });
    await delay(5);
    assert.equal(failures.length, 1);
    await assert.rejects(client.usage(), /exited/);
    client.close();
  } finally {
    restoreFactory();
  }
});

test("review r1: child exit BEFORE the submit ACK — one caller rejection, no unhandledRejection", async () => {
  installFake();
  // The exact mechanism from the review: #fail while prompt() still awaits the
  // ACK rejects BOTH the pending submit RPC and the local turn promise (via the
  // waiter). prompt()'s catch path rethrows the submit error and never returns
  // `turn` — without a handler attached, that orphaned rejection surfaces as a
  // process-level unhandledRejection (Node ≥15: uncaught-exception-grade).
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const { client, child } = await withSession();
    const promptP = client.prompt("doomed at submit time");
    await delay(5); // submit written, ACK deliberately never sent
    child.emitExit(1, null); // #fail: pending.reject + #settleTurn → turn rejected
    await assert.rejects(promptP, /exited/); // the caller's ONE rejection
    await delay(30); // let the loop surface any orphaned rejection
    assert.deepEqual(unhandled, []); // none may occur
    // same mechanism via close() mid-submit (fresh client + ITS fake child)
    const client2 = await startReady();
    const child2 = lastChild;
    const createP2 = client2.createSession({ cwd: "/w" });
    await delay(5);
    child2.respond(child2.lastRequest.id, { session_id: "s2" });
    await createP2;
    const promptP2 = client2.prompt("closed at submit time");
    await delay(5);
    client2.close();
    await assert.rejects(promptP2, /closed/);
    await delay(30);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    restoreFactory();
  }
});

test("close(): best-effort session.close write + SIGTERM + pending rejected + onFailure", async () => {
  installFake();
  try {
    const { client, child } = await withSession();
    const failures = [];
    client.onFailure((e) => failures.push(e));
    const usageP = client.usage();
    await delay(5);
    client.close();
    assert.equal(child.lastRequest.method, "session.close");
    assert.deepEqual(child.lastRequest.params, { session_id: "s1" });
    assert.ok(child.killSignals.includes("SIGTERM"));
    await assert.rejects(usageP, /closed/);
    assert.equal(failures.length, 1);
    await assert.rejects(client.prompt("x"), /closed/);
    // idempotent
    client.close();
    assert.equal(child.killSignals.length, 1);
    assert.equal(failures.length, 1);
  } finally {
    restoreFactory();
  }
});
test("spawn grace (probe opt-in): a never-materialized probe client closes its idle child (I3, rescoped)", async () => {
  // 2026-09-17 ruling 4: the reaper is OPT-IN via spawn({spawnGraceMs}) — only
  // the self-closing catalog-probe client arms it. Agent-held clients (no
  // spawnGraceMs) never reap (covered by the next test).
  installFake();
  try {
    const client = await startReady({ spawnGraceMs: 60 });
    assert.equal(lastChild.killed, false, "child alive while no session is bound");
    // No createSession/resumeSession → the grace timer fires and closes it.
    await delay(200);
    assert.equal(lastChild.killed, true, "grace timer closed the idle probe child");
    assert.ok(lastChild.killSignals.includes("SIGTERM"));
    assert.equal(client.closed, true);
    assert.equal(client.usable, false);
  } finally {
    restoreFactory();
  }
});

// ---- ruling 4 (2026-09-17): usable/closed/failure getters + reaper scope ----

test("reaper scope (ruling 4): an agent-held client never arms the spawn-grace reaper", async () => {
  installFake();
  try {
    // No spawnGraceMs → no reaper (agent-held posture: the gateway session may
    // materialize at the first prompt, arbitrarily far in the future).
    const client = await startReady({});
    await delay(200);
    assert.equal(lastChild.killed, false, "agent-held child survives far past any grace");
    assert.equal(client.usable, true, "client still usable");
    assert.equal(client.failure, null);
    client.close();
  } finally {
    restoreFactory();
  }
});

test("liveness getters: usable/closed/failure track the terminal states", async () => {
  installFake();
  try {
    const client = await startReady({});
    assert.equal(client.usable, true);
    assert.equal(client.closed, false);
    assert.equal(client.failure, null);
    // close() stamps the terminal failure AND closed.
    client.close();
    assert.equal(client.closed, true);
    assert.equal(client.usable, false);
    assert.ok(client.failure instanceof Error);
    assert.match(client.failure.message, /client closed/);

    // A pre-ready child crash respawns (bounded), then stamps failure +
    // usable:false WITHOUT closed (2026-09-18 retry ruling). Short ready
    // timeouts drive the respawned children to their attempts quickly.
    const crashClient = HermesGatewayClient.spawn({ readyTimeoutMs: 100 });
    const readyP = crashClient.ensureStarted();
    readyP.catch(() => {}); // handled: the crash rejects the ready gate
    lastChild.emitExit(1, null); // attempt 1 dies; attempts 2..3 time out
    await assert.rejects(readyP, /gateway child exited|timed out waiting for gateway.ready/);
    assert.equal(crashClient.closed, false);
    assert.equal(crashClient.usable, false);
    assert.ok(crashClient.failure instanceof Error);
  } finally {
    restoreFactory();
  }
});

test("onAdopted: fires once at session.create adoption with the raw response", async () => {
  installFake();
  try {
    const client = await startReady({});
    const adopted = [];
    const off = client.onAdopted((info) => adopted.push(info));
    const createP = client.createSession({ cwd: "/w/p" });
    await delay(5);
    lastChild.respond(lastChild.lastRequest.id, { session_id: "s1", stored_session_id: "k1" });
    await createP;
    assert.equal(adopted.length, 1, "adoption fires exactly once");
    assert.equal(adopted[0].session_id, "s1");
    assert.equal(adopted[0].stored_session_id, "k1");
    client.close();
    off();
  } finally {
    restoreFactory();
  }
});

test("onAdopted: resume with a REMINTED stored_session_id surfaces the drift; unsubscribe works", async () => {
  installFake();
  try {
    const client = await startReady({});
    const adopted = [];
    const off = client.onAdopted((info) => adopted.push(info));
    const resumeP = client.resumeSession("k-old");
    await delay(5);
    // The gateway remints the durable key on resume (drift).
    lastChild.respond(lastChild.lastRequest.id, { session_id: "s9", stored_session_id: "k-new" });
    await resumeP;
    assert.equal(client.storedSessionId, "k-new");
    assert.equal(adopted.length, 1);
    assert.equal(adopted[0].stored_session_id, "k-new", "the reminted key is what the provider's map will upsert");
    off();
    client.close();
  } finally {
    restoreFactory();
  }
});

test("spawn grace: materializing a session clears the reaper", async () => {
  installFake();
  try {
    const client = await startReady({ spawnGraceMs: 60 });
    const createP = client.createSession({ cwd: "/w/p" });
    await delay(5);
    lastChild.respond(lastChild.lastRequest.id, { session_id: "s1", stored_session_id: "k1" });
    await createP;
    // Wait past the grace window — the session materialized, so the child must survive.
    await delay(200);
    assert.equal(lastChild.killed, false, "materialized session survives the grace window");
    client.close();
  } finally {
    restoreFactory();
  }
});


test("resume: subsequent prompt.submit uses the newly adopted live id (not the durable key)", async () => {
  installFake();
  try {
    const client = await startReady();
    const resumeP = client.resumeSession("k-old");
    await delay(5);
    lastChild.respond(lastChild.lastRequest.id, { session_id: "s9", stored_session_id: "k-old", message_count: 0 });
    await resumeP;
    assert.equal(client.sessionId, "s9");
    assert.equal(client.storedSessionId, "k-old");

    const promptP = client.prompt("hi");
    await delay(5);
    assert.equal(lastChild.lastRequest.method, "prompt.submit");
    assert.deepEqual(lastChild.lastRequest.params, { session_id: "s9", text: "hi" });
    client.close();
    await assert.rejects(promptP, /closed/);
  } finally {
    restoreFactory();
  }
});

test("adoptSession defensive: resume returning only the durable key adopts it as the live id", async () => {
  installFake();
  try {
    const client = await startReady();
    const resumeP = client.resumeSession("k-dur");
    await delay(5);
    lastChild.respond(lastChild.lastRequest.id, { session_id: "", stored_session_id: "k-dur" });
    const session = await resumeP;
    assert.equal(session.stored_session_id, "k-dur");
    assert.equal(client.sessionId, "k-dur", "durable key adopted as live id when live id is absent");
    assert.equal(client.storedSessionId, "k-dur");
    client.close();
  } finally {
    restoreFactory();
  }
});
