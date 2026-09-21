import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSlashCommandMount } from "../dist/discovery.js";

/** Fake host commands runtime recording registrations and their disposals. */
function fakeRuntime() {
  const registered = [];
  const removed = [];
  return {
    registered,
    removed,
    register(definition) {
      registered.push(definition);
      return () => removed.push(definition.name);
    },
  };
}

test("mount registers the boot scan; refresh swaps the live set", () => {
  const home = mkdtempSync(join(tmpdir(), "omp-mount-home-"));
  process.env.OMP_NATIVE_HOME = join(home, ".omp");
  const commandsDir = join(home, ".omp", "agent", "commands");
  mkdirSync(commandsDir, { recursive: true });
  writeFileSync(join(commandsDir, "deploy.md"), "Deploy now");
  try {
    const runtime = fakeRuntime();
    const mount = createSlashCommandMount(runtime);
    assert.deepEqual(runtime.registered.map((d) => d.name), ["deploy"]);
    assert.deepEqual(runtime.removed, []);
    assert.equal(runtime.registered[0].handler().text, "Deploy now");

    // A new file appears and an old one disappears: refresh swaps atomically.
    writeFileSync(join(commandsDir, "review.md"), "Review it");
    unlinkSync(join(commandsDir, "deploy.md"));
    mount.refresh();
    assert.deepEqual(runtime.registered.map((d) => d.name), ["deploy", "review"]);
    assert.deepEqual(runtime.removed, ["deploy"]);
    mount.disposeAll();
    assert.deepEqual(runtime.removed, ["deploy", "review"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
    delete process.env.OMP_NATIVE_HOME;
  }
});

test("command names are sanitized to the host shape; empty degrades", () => {
  const home = mkdtempSync(join(tmpdir(), "omp-mount-san-"));
  process.env.OMP_NATIVE_HOME = join(home, ".omp");
  const commandsDir = join(home, ".omp", "agent", "commands");
  mkdirSync(commandsDir, { recursive: true });
  writeFileSync(join(commandsDir, "My Cool Cmd!.md"), "body");
  try {
    const runtime = fakeRuntime();
    createSlashCommandMount(runtime).disposeAll();
    // sanitizer keeps the trailing dash from "!" — upstream-original behavior.
    assert.deepEqual(runtime.registered.map((d) => d.name), ["my-cool-cmd-"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
    delete process.env.OMP_NATIVE_HOME;
  }
});

test("empty/missing roots mount nothing and refresh stays a no-op", () => {
  const home = mkdtempSync(join(tmpdir(), "omp-mount-empty-"));
  process.env.OMP_NATIVE_HOME = join(home, ".omp");
  try {
    const runtime = fakeRuntime();
    const mount = createSlashCommandMount(runtime);
    assert.deepEqual(runtime.registered, []);
    mount.refresh();
    assert.deepEqual(runtime.registered, []);
    mount.disposeAll();
    assert.deepEqual(runtime.removed, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
    delete process.env.OMP_NATIVE_HOME;
  }
});
