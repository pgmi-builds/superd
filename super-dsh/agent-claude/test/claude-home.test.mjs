// agent-claude/test/claude-home.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

const { resolveClaudeHome, assertNotProdHome } = await import("../dist/claude-home.js");

test("resolveClaudeHome defaults to the native ~/.claude (never redirected)", () => {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    assert.equal(resolveClaudeHome(), join(process.env.HOME ?? "/root", ".claude"));
  } finally {
    if (previous !== undefined) process.env.CLAUDE_CONFIG_DIR = previous;
  }
});

test("resolveClaudeHome honors an ambient CLAUDE_CONFIG_DIR (test override)", () => {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = "/tmp/cc-isolated";
  try {
    assert.equal(resolveClaudeHome(), "/tmp/cc-isolated");
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
});

test("resolveClaudeHome refuses a prod home set via CLAUDE_CONFIG_DIR", () => {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = "/home/u1/.dsh";
  try {
    assert.throws(() => resolveClaudeHome(), /refusing prod home/);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
});

test("assertNotProdHome refuses the prod homes", () => {
  assert.throws(() => assertNotProdHome("/home/u1/.dsh/agents/claude", "home"), /refusing prod home/);
  assert.throws(() => assertNotProdHome("/home/u1/.superd/x", "home"), /refusing prod home/);
  assert.doesNotThrow(() => assertNotProdHome("/tmp/superd/.tests/agents/claude", "home"));
});
