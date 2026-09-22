// src/pi-home.ts — the adapter's DSH-side state-dir resolution:
// `<dshHomePath>/agents/pi` (mapping file home only — pi's RUNTIME home stays
// the native `~/.pi`; this module never redirects PI_CODING_AGENT_DIR).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { resolvePiStateDir, piMappingPath } = await import("../dist/pi-home.js");

function tempHome() {
  return mkdtempSync(join(tmpdir(), "aw-pi-home-"));
}

test("resolvePiStateDir nests agents/pi under an explicit dsh home", () => {
  const home = tempHome();
  assert.equal(resolvePiStateDir(home), join(home, "agents", "pi"));
});

test("piMappingPath puts dsh-sessions.json in the state dir", () => {
  const home = tempHome();
  assert.equal(piMappingPath(home), join(home, "agents", "pi", "dsh-sessions.json"));
});

test("resolvePiStateDir falls back to $DSH_HOME then the line default", () => {
  const home = tempHome();
  process.env.DSH_HOME = home;
  try {
    assert.equal(resolvePiStateDir(), join(home, "agents", "pi"));
  } finally {
    delete process.env.DSH_HOME;
  }
});

test("world form: a home that is already agents/pi is the state dir itself", () => {
  const lineHome = tempHome();
  const worldHome = join(lineHome, "agents", "pi");
  mkdirSync(worldHome, { recursive: true });
  assert.equal(resolvePiStateDir(worldHome), worldHome);
});

