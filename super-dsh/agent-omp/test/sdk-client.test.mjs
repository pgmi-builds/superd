import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Native-home ruling (2026-09-17): the adapter's default OMP home is the
// operator's native ~/.omp. Tests pin an isolated home via the env knob
// BEFORE the dist import — knobs freezes OMP_HOME at module load.
process.env.OMP_HOME = mkdtempSync(join(tmpdir(), "aw-omp-sdk-"));

const { OmpSdkClient } = await import("../dist/sdk-client.js");

test("OmpSdkClient surface parity over shared sidecar", async (t) => {
  const a = await OmpSdkClient.spawn(["--approval-mode", "yolo"]);
  t.after(() => a.close());
  const b = await OmpSdkClient.spawn();
  t.after(() => b.close());

  const stateA = await a.getState();
  assert.equal(typeof stateA.isStreaming, "boolean");
  assert.ok(stateA.sessionId, "omp session id present");
  assert.ok(stateA.sessionFile, "file-backed session");

  // isolation: two clients hold different sessions
  const stateB = await b.getState();
  assert.notEqual(stateA.sessionId, stateB.sessionId);

  assert.deepEqual(await a.getMessages(), []);
  assert.deepEqual(await a.getSubagents(), []);
  assert.equal(typeof (await a.getSessionStats()).contextUsage, "object");

  // raw send compatibility path
  const resp = await a.send({ type: "get_state" });
  assert.equal(resp.success, true);
  assert.equal(resp.data.sessionId, stateA.sessionId);

  // sendRaw (extension_ui_response) must not throw
  a.sendRaw({ type: "extension_ui_response", id: "x", value: "Deny" });

  // unsupported arg fails loudly
  await assert.rejects(() => OmpSdkClient.spawn(["--unknown-flag"]));
});
