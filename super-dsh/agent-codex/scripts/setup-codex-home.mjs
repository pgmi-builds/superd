#!/usr/bin/env node
/**
 * setup-codex-home.mjs — copy the native Codex configs from the user's real
 * `~/.codex` into the adapter's nested home (spec S7 "测试期拷入"; the
 * import-once mechanism is explicitly skipped, direct copy is the sanctioned
 * test posture). Idempotent: existing files are left untouched.
 *
 * Source set (2026-09-10 field facts): config.toml (custom provider via
 * cc-switch, default model glm-5.2), auth.json (apikey login state),
 * cc-switch-model-catalog.json (model catalog referenced by config.toml).
 *
 * Env:
 *   DSH_HOME            — test home root (default <cwd>/.tests/aw)
 *   CODEX_HOME          — override of the nested home (default <DSH_HOME>/agents/codex)
 *   SOURCE_CODEX_HOME   — override of the copy source (default ~/.codex; READ-ONLY)
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
const home = resolve(process.env.DSH_HOME ?? join(process.cwd(), ".tests", "aw"));
// Red line guard (repo AGENTS.md): never resolve into the prod homes. An
// ambient DSH_HOME from the interactive environment must never win by accident.
const PROD_HOMES = [join(homedir(), ".dsh"), join(homedir(), ".superd")];
if (PROD_HOMES.includes(home) || PROD_HOMES.some((p) => home.startsWith(`${p}/`))) {
  console.error(`setup-codex-home: refusing prod home "${home}" — set DSH_HOME to the test home explicitly`);
  process.exit(1);
}
const codexHome = process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(home, "agents", "codex");
if (PROD_HOMES.includes(codexHome) || PROD_HOMES.some((p) => codexHome.startsWith(`${p}/`))) {
  console.error(`setup-codex-home: refusing prod CODEX_HOME "${codexHome}"`);
  process.exit(1);
}
const source = resolve(process.env.SOURCE_CODEX_HOME ?? join(homedir(), ".codex"));

mkdirSync(codexHome, { recursive: true });
const files = ["config.toml", "auth.json", "cc-switch-model-catalog.json"];
let copied = 0;
for (const file of files) {
  const dst = join(codexHome, file);
  if (existsSync(dst)) continue;
  const from = join(source, file);
  if (!existsSync(from)) {
    console.error(`setup-codex-home: missing ${from} — run on the real filesystem or set SOURCE_CODEX_HOME`);
    process.exit(1);
  }
  copyFileSync(from, dst);
  copied += 1;
}
console.log(`setup-codex-home: ${copied} copied (${files.length - copied} already present), home=${codexHome}`);
