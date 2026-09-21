// 2026-09-18 full-lazy + bounded-retry ruling: viewing/creating a session
// spawns NOTHING; the python child exists only from the first prompt until
// idle-exit. Pre-ready failures (spawn/ready phase) respawn the child inside
// the SAME client object (closures/listeners stay valid), bounded at
// HERMES_SPAWN_ATTEMPTS; post-ready failures stay terminal.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import {
  HermesGatewayClient,
  setGatewayFactory,
  HERMES_SPAWN_ATTEMPTS,
} from "../dist/hermes-client.js";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

class FakeStdin extends Writable {
  _write(chunk, _enc, cb) { cb(); }
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new FakeStdin();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.killed = false;
    this._exited = false;
  }
  kill(signal = "SIGTERM") {
    this.killed = true;
    this.emitExit(null, signal);
  }
  emitExit(code, signal) {
    if (this._exited) return;
    this._exited = true;
    this.exitCode = code;
    this.emit("exit", code, signal);
  }
  emitReady() {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready" } })}\n`);
  }
}

/** Scripted factory: each entry says how the nth child behaves. */
function installScripted(scripts) {
  const children = [];
  setGatewayFactory(() => {
    const child = new FakeChild();
    children.push(child);
    const script = scripts[Math.min(children.length - 1, scripts.length - 1)];
    // setImmediate: the client wires stdout/exit listeners AFTER the factory
    // returns — synchronous emits would be lost events.
    if (script !== undefined) setImmediate(() => script(child));
    return child;
  });
  return children;
}

test("lazy spawn defers the python child until the first ensureStarted", async () => {
  const children = installScripted([(child) => child.emitReady()]);
  const client = HermesGatewayClient.spawn({ lazy: true });
  assert.equal(children.length, 0, "no child at construction");
  const ready = client.ensureStarted();
  assert.equal(children.length, 1, "ensureStarted materializes the child");
  await ready;
  assert.equal(client.usable, true);
  client.close();
  setGatewayFactory(null);
});

test("eager spawn (probe) still starts immediately", () => {
  const children = installScripted([]);
  HermesGatewayClient.spawn({ spawnGraceMs: 1 });
  assert.equal(children.length, 1, "non-lazy clients keep the eager behavior");
  setGatewayFactory(null);
});

test(`pre-ready exit respawns on the SAME client (bounded at ${HERMES_SPAWN_ATTEMPTS})`, async () => {
  assert.equal(HERMES_SPAWN_ATTEMPTS, 3);
  const children = installScripted([
    (child) => child.emitExit(1),            // attempt 1 dies pre-ready
    (child) => child.emitReady(),            // attempt 2 reaches ready
  ]);
  const client = HermesGatewayClient.spawn({ lazy: true });
  const ready = client.ensureStarted();
  await ready;
  assert.equal(children.length, 2, "exactly one respawn happened");
  assert.equal(client.usable, true, "no terminal failure was stamped");
  client.close();
  setGatewayFactory(null);
});

test("pre-ready failures exhaust attempts and turn terminal", async () => {
  const children = installScripted([(child) => child.emitExit(1)]);
  const client = HermesGatewayClient.spawn({ lazy: true, readyTimeoutMs: 50 });
  await assert.rejects(() => client.ensureStarted(), /gateway child exited/);
  assert.equal(children.length, HERMES_SPAWN_ATTEMPTS, "all attempts burned");
  assert.equal(client.usable, false, "terminal failure stamped after the last attempt");
  setGatewayFactory(null);
});

test("post-ready exit is terminal — no respawn", async () => {
  const children = installScripted([(child) => child.emitReady()]);
  const client = HermesGatewayClient.spawn({ lazy: true });
  await client.ensureStarted();
  const failed = new Promise((resolve) => client.onFailure(resolve));
  children[0].emitExit(0);
  await failed;
  await delay(10);
  assert.equal(children.length, 1, "a ready client never respawns");
  assert.equal(client.usable, false);
  setGatewayFactory(null);
});
