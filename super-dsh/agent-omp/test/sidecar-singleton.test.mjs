import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Regression guard for the shared-sidecar singleton (sdk-client.ts `acquire`).
 *
 * History: the omp-web base built one child per acquire cycle, then a re-copy of
 * the adapter from dsh-omp master HEAD applied the OMP_HOME pin as an INSERTION
 * instead of a replacement. Both constructions stayed, so every acquire started
 * a second child (with OMP_HOME unset) and abandoned the first — started,
 * unreferenced, never stopped. That leaked a live ~200 MB bun sidecar per
 * session/settings call (350 spawns in one instance's log, with a 11h orphan).
 *
 * The invariant is deliberately asserted on source, not on a live spawn: the
 * leak was a duplicated construction, and a source check catches exactly that
 * class of edit without booting a 200 MB process per test run.
 */
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "src", "sdk-client.ts"), "utf8");

/** The `acquire()` body: from its declaration to the first line-start `}`. */
function acquireBody(text) {
  const start = text.indexOf("function acquire()");
  assert.notStrictEqual(start, -1, "sdk-client.ts must still declare acquire()");
  const end = text.indexOf("\n}", start);
  assert.notStrictEqual(end, -1, "acquire() must close at column 0");
  return text.slice(start, end + 2);
}

test("acquire() constructs the sidecar exactly once", () => {
  const body = acquireBody(source);
  const constructions = body.match(/new OmpSdkSidecar\(/g) ?? [];
  assert.strictEqual(
    constructions.length,
    1,
    `acquire() must build one child per cycle; found ${constructions.length}:\n${body}`,
  );
});

test("the shared sidecar is pinned to the OMP app home", () => {
  const body = acquireBody(source);
  assert.match(
    body,
    /new OmpSdkSidecar\(\{\s*env:\s*\{\s*OMP_HOME\s*\}\s*\}\)/,
    "the single construction must carry the OMP_HOME pin (the child's app home)",
  );
});

test("acquire() starts the child it keeps", () => {
  const body = acquireBody(source);
  const starts = body.match(/sharedStart = shared\.start\(\)/g) ?? [];
  assert.strictEqual(starts.length, 1, "exactly one start() per construction — no second, abandoned child");
});
