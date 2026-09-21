import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSlashCommands, readSkills } from "../dist/omp-disk-discovery.js";

/** Build an isolated fake HOME + cwd with discovery roots, run fn, clean up. */
function withFakeWorld(fn) {
  const home = mkdtempSync(join(tmpdir(), "omp-disk-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "omp-disk-cwd-"));
  const originals = { home: process.env.HOME, native: process.env.OMP_NATIVE_HOME };
  process.env.HOME = home;
	// resolveOmpNativeHome() reads OMP_NATIVE_HOME per call (test-injectable):
	// mirror the real layout where the native root (~/.omp) sits under HOME.
	process.env.OMP_NATIVE_HOME = join(home, ".omp");
  try {
    fn({ home, cwd });
  } finally {
    process.env.HOME = originals.home;
    if (originals.native === undefined) delete process.env.OMP_NATIVE_HOME;
    else process.env.OMP_NATIVE_HOME = originals.native;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("no discovery roots → empty results, never throws", () => {
  withFakeWorld(({ home }) => {
    assert.deepEqual(readSlashCommands(home), []);
    assert.deepEqual(readSkills(home), []);
  });
});

test("commands: frontmatter description wins; body is content; sorted", () => {
  withFakeWorld(({ home, cwd }) => {
    mkdirSync(join(home, ".omp", "agent", "commands"), { recursive: true });
    writeFileSync(
      join(home, ".omp", "agent", "commands", "deploy.md"),
      "---\ndescription: Ship it\nargument-hint: <env>\n---\nDeploy to $ARGUMENTS now",
    );
    writeFileSync(
      join(home, ".omp", "agent", "commands", "bare.md"),
      "first line becomes the description\nrest of body",
    );
    mkdirSync(join(cwd, ".omp", "commands"), { recursive: true });
    writeFileSync(join(cwd, ".omp", "commands", "local-only.md"), "project command body");

    const found = readSlashCommands(cwd);
    assert.deepEqual(found.map((c) => c.name), ["bare", "deploy", "local-only"]);
    const deploy = found.find((c) => c.name === "deploy");
    assert.equal(deploy.description, "Ship it");
    assert.equal(deploy.content, "Deploy to $ARGUMENTS now");
    assert.equal(deploy.source, "omp:user");
    const local = found.find((c) => c.name === "local-only");
    assert.equal(local.source, "omp:project");
    assert.match(local.filePath, /\.omp/);
  });
});

test("commands: same name — user root wins over project root", () => {
  withFakeWorld(({ home, cwd }) => {
    mkdirSync(join(home, ".omp", "agent", "commands"), { recursive: true });
    mkdirSync(join(cwd, ".omp", "commands"), { recursive: true });
    writeFileSync(join(home, ".omp", "agent", "commands", "dup.md"), "user body");
    writeFileSync(join(cwd, ".omp", "commands", "dup.md"), "project body");
    const found = readSlashCommands(cwd);
    assert.equal(found.length, 1);
    assert.equal(found[0].content, "user body");
  });
});

test("skills: <name>/SKILL.md standard layout + frontmatter name override", () => {
  withFakeWorld(({ home, cwd }) => {
    mkdirSync(join(home, ".omp", "agent", "skills", "reviewer"), { recursive: true });
    writeFileSync(
      join(home, ".omp", "agent", "skills", "reviewer", "SKILL.md"),
      "---\nname: code-reviewer\ndescription: Reviews code carefully\n---\nBody of the skill",
    );
    mkdirSync(join(cwd, ".claude", "skills", "tuner"), { recursive: true });
    writeFileSync(join(cwd, ".claude", "skills", "tuner", "SKILL.md"), "Tunes things");

    const found = readSkills(cwd);
    assert.deepEqual(found.map((s) => s.name), ["code-reviewer", "tuner"]);
    const reviewer = found.find((s) => s.name === "code-reviewer");
    assert.equal(reviewer.description, "Reviews code carefully");
    assert.equal(reviewer.source, "omp:user");
    assert.match(reviewer.filePath, /SKILL\.md$/);
    const tuner = found.find((s) => s.name === "tuner");
    assert.equal(tuner.description, "Tunes things"); // fallback: first body line
    assert.equal(tuner.source, "claude:project");
  });
});

test("skills: no cwd → project roots skipped, user roots still read", () => {
  withFakeWorld(({ home }) => {
    mkdirSync(join(home, ".omp", "agent", "skills", "solo"), { recursive: true });
    writeFileSync(join(home, ".omp", "agent", "skills", "solo", "SKILL.md"), "Solo skill");
    const found = readSkills(undefined);
    assert.equal(found.length, 1);
    assert.equal(found[0].name, "solo");
  });
});

test("malformed frontmatter degrades to whole-file body, never throws", () => {
  withFakeWorld(({ home }) => {
    mkdirSync(join(home, ".omp", "agent", "commands"), { recursive: true });
    writeFileSync(join(home, ".omp", "agent", "commands", "broken.md"), "---\ndescription: [unclosed\nbody after");
    const found = readSlashCommands(home);
    assert.equal(found.length, 1);
    assert.equal(found[0].name, "broken");
    assert.ok(found[0].content.length > 0);
  });
});
