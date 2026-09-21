import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ompConfigPath resolves OMP_NATIVE_HOME per call — inject the root before use.
const home = mkdtempSync(join(tmpdir(), "omp-roles-disk-"));
process.env.OMP_NATIVE_HOME = home;
const agentDir = join(home, "agent");
mkdirSync(agentDir, { recursive: true });

const { readOmpModelRolesFromConfig, readOmpDefaultModelFromConfig } = await import(
  "../dist/omp-store.js"
);

test("no config file → undefined (never throws)", () => {
  assert.equal(readOmpModelRolesFromConfig(), undefined);
  assert.equal(readOmpDefaultModelFromConfig(), undefined);
});

test("whole modelRoles map is read; default delegates with effort suffix dropped", () => {
  writeFileSync(
    join(agentDir, "config.yml"),
    [
      "theme:",
      "  dark: titanium",
      "modelRoles:",
      "  default: deepseek/deepseek-v4-pro",
      "  plan: zai-plan/glm-4.7:high",
      "  codeReview: deepseek/deepseek-v4-flash",
      "other: value",
    ].join("\n"),
  );
  assert.deepEqual(readOmpModelRolesFromConfig(), {
    default: "deepseek/deepseek-v4-pro",
    plan: "zai-plan/glm-4.7:high",
    codeReview: "deepseek/deepseek-v4-flash",
  });
  assert.deepEqual(readOmpDefaultModelFromConfig(), { provider: "deepseek", model: "deepseek-v4-pro" });
});

test("block ends at the first non-indented line; empty block → undefined", () => {
  writeFileSync(
    join(agentDir, "config.yml"),
    ["modelRoles:", "  default: deepseek/deepseek-v4-pro", "next:", "  key: value"].join("\n"),
  );
  assert.deepEqual(readOmpModelRolesFromConfig(), { default: "deepseek/deepseek-v4-pro" });

  writeFileSync(join(agentDir, "config.yml"), "modelRoles:\nnext:\n  key: value\n");
  assert.equal(readOmpModelRolesFromConfig(), undefined);
  assert.equal(readOmpDefaultModelFromConfig(), undefined);
});

test("malformed selector line is carried raw in the map; default parse yields undefined", () => {
  writeFileSync(join(agentDir, "config.yml"), "modelRoles:\n  default: not-a-selector\n");
  assert.deepEqual(readOmpModelRolesFromConfig(), { default: "not-a-selector" });
  assert.equal(readOmpDefaultModelFromConfig(), undefined);
});

test("cleanup", () => {
  rmSync(home, { recursive: true, force: true });
  assert.ok(true);
});
