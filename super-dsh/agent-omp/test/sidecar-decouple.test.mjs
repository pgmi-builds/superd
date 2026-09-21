import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Env BEFORE dynamic import: knobs freezes OMP_HOME at module load.
const tmp = mkdtempSync(join(tmpdir(), "omp-decouple-"));
process.env.OMP_HOME = join(tmp, "omp-app");
process.env.OMP_NATIVE_HOME = join(tmp, "omp-native");

const { callShared, callSharedIfLive, isSharedSidecarLive } = await import("../dist/sdk-client.js");

// Scoped spawn check: only a sidecar whose OMP_HOME matches THIS test's tmp
// app home counts — the full-suite runner executes test files concurrently, so
// a global `ps` would see other files' children.
function bunChildren() {
  let lines;
  try {
    lines = execSync('ps -eo pid,args | grep "[s]idecar/main.ts"').toString().trim().split("\n");
  } catch {
    return ""; // grep found nothing
  }
  const mine = lines.filter((line) => {
    const pid = line.trim().split(/\s+/)[0];
    try {
      return readFileSync(`/proc/${pid}/environ`, "latin1").includes(`OMP_HOME=${join(tmp, "omp-app")}`);
    } catch {
      return false;
    }
  });
  return mine.join("\n");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("source: create AND resume are both lazy — no eager OmpSdkClient.spawn in the adapter", () => {
  // AGENTS.md §一: the eager-resume recurrence (2026-09-15) is a named
  // regression point. The adapter must never call OmpSdkClient.spawn directly;
  // only LazyOmpRpc (first dispatch) may materialize a child.
  const index = readFileSync(join(import.meta.dirname, "..", "src", "index.ts"), "utf8");
  assert.doesNotMatch(index, /OmpSdkClient\.spawn\(/, "resume must use LazyOmpRpc, not an eager spawn");
  const lazy = readFileSync(join(import.meta.dirname, "..", "src", "lazy-rpc.ts"), "utf8");
  assert.match(lazy, /OmpSdkClient\.spawn\(/, "LazyOmpRpc remains the only spawn site");
});

test("source: the periodic catalog path is live-gated, warm functions are gone", () => {
  const cli = readFileSync(join(import.meta.dirname, "..", "src", "omp-cli.ts"), "utf8");
  assert.doesNotMatch(cli, /ensureModelsWarm|ensureRolesWarm/, "boot warm must not exist");
  const modelsList = cli.slice(cli.indexOf("sidecarModelsList"), cli.indexOf("sidecarModelRolesGet"));
  assert.match(modelsList, /callSharedIfLive/, "models.list must be live-gated");
  const sdk = readFileSync(join(import.meta.dirname, "..", "src", "sdk-client.ts"), "utf8");
  assert.match(sdk, /export async function callSharedIfLive/, "gate must be exported");
});

test("cold callSharedIfLive resolves undefined and spawns NOTHING", async () => {
  assert.equal(isSharedSidecarLive(), false);
  const result = await callSharedIfLive("models.list", {});
  assert.equal(result, undefined);
  assert.equal(bunChildren(), "", "a cold live-gated call must not start a sidecar");
});

test("callShared still spawns on real need (contrast case), then dies on release", async () => {
  const pong = await callShared("sys.ping");
  assert.equal(pong.pong, true);
  assert.match(bunChildren(), /sidecar\/main\.ts/, "on-demand call may spawn");
  await sleep(4500); // release → stdin end (+SIGTERM grace) → child gone
  assert.equal(bunChildren(), "", "released sidecar must be gone");
  rmSync(tmp, { recursive: true, force: true });
});
