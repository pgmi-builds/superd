// Task 3 live smoke — HermesGatewayClient against the REAL gateway child.
//
// DOUBLE-GATED (constraint: the live prompt budget of 2 turns is EXHAUSTED):
//   - HERMES_LIVE=1          → run this file at all (spawns a real gateway).
//   - HERMES_LIVE_PROMPT=1   → additionally allow ONE prompt turn. DEFAULT OFF
//     and currently FORBIDDEN — no prompt-turn budget remains. Task 9 (live
//     smoke gate) decides when (if ever) to spend it.
//
// Without HERMES_LIVE this file is inert (cheap placeholder assertion only).
// The no-prompt path exercises: spawn → gateway.ready → session.create →
// session.usage/status/history (read-only, no model call) → close. Creating a
// lazy session persists no state.db row until the first prompt, so this path
// stays read-only against ~/.hermes (Task 1 §3⑤ live fact).
//
// NOT RUN during Task 3 development — fixture/unit coverage only.
import test from "node:test";
import assert from "node:assert/strict";

const LIVE = process.env.HERMES_LIVE === "1";
const LIVE_PROMPT = process.env.HERMES_LIVE_PROMPT === "1";
// Task-1-constraint cwd (sanctioned scratch dir; mkdir'd defensively).
const SPIKE_CWD = "/home/u1/workspaces/superd/.scratch/hermes-spike-cwd";

test("hermes client live smoke placeholder (set HERMES_LIVE=1)", () => {
  if (!LIVE) {
    assert.ok(true, "skipped: HERMES_LIVE not set — unit/fixture coverage lives in hermes-client.test.mjs");
    return;
  }
});

test("live: spawn → ready → session.create → read RPCs → close (NO prompt turn)", { skip: !LIVE }, async () => {
  const { mkdirSync } = await import("node:fs");
  const { HermesGatewayClient, setGatewayFactory } = await import("../dist/hermes-client.js");
  setGatewayFactory(null); // real child (defensive: tests may have injected a fake)
  mkdirSync(SPIKE_CWD, { recursive: true });
  const client = HermesGatewayClient.spawn({ cwd: SPIKE_CWD });
  const wire = [];
  const off = client.on((event) => wire.push(event.type));
  const failures = [];
  const offFail = client.onFailure((error) => failures.push(error));
  try {
    await client.ensureStarted(); // gateway.ready (15s timeout, TUI parity)
    const session = await client.createSession({
      cwd: SPIKE_CWD,
      title: "dsh-aw client-smoke", // dsh-aw prefix mandated by the constraints
    });
    assert.equal(typeof session.session_id, "string", "live session_id");
    // Read-only surface — none of these performs a model call.
    const usage = await client.usage();
    assert.equal(typeof usage.calls, "number", "usage.calls present");
    const status = await client.status();
    assert.equal(typeof status.output, "string", "status.output rendered blob");
    const history = await client.history();
    assert.equal(typeof history.count, "number", "history.count present");
    assert.equal(failures.length, 0, "no failure during the smoke");
  } finally {
    off();
    offFail();
    client.close(); // best-effort session.close + SIGTERM→SIGKILL
  }
});

test("live: ONE prompt turn through the client (FORBIDDEN until Task 9 grants budget)", { skip: !(LIVE && LIVE_PROMPT) }, async () => {
  const { mkdirSync } = await import("node:fs");
  const { HermesGatewayClient, setGatewayFactory } = await import("../dist/hermes-client.js");
  setGatewayFactory(null);
  mkdirSync(SPIKE_CWD, { recursive: true });
  const client = HermesGatewayClient.spawn({ cwd: SPIKE_CWD });
  const wire = [];
  const off = client.on((event) => wire.push(event.type));
  try {
    await client.ensureStarted();
    await client.createSession({ cwd: SPIKE_CWD, title: "dsh-aw client-prompt" });
    // Resolves on the settled pair (message.complete → session.info running=false).
    await client.prompt("Reply with exactly: ok");
    assert.ok(wire.includes("agent_start") && wire.includes("message_end") && wire.includes("agent_end"));
  } finally {
    off();
    client.close();
  }
});
