#!/usr/bin/env node
/**
 * mock_agy.mjs — test double for the agy CLI stream-json surface.
 * AGY_MOCK_SCRIPT: JSON array of raw stdout lines to emit in order
 * (consumed one per stdin line, like mock_bridge.mjs).
 * AGY_MOCK_TRACE: file receiving {argv} on startup (spawn-args assertions).
 */
import { appendFileSync } from "node:fs";

if (process.env.AGY_MOCK_TRACE) {
  appendFileSync(process.env.AGY_MOCK_TRACE, JSON.stringify({ argv: process.argv.slice(2) }) + "\n");
}

const traceFile = process.env.AGY_MOCK_TRACE;
const script = JSON.parse(process.env.AGY_MOCK_SCRIPT ?? "[]");

function emitStep(step) {
  for (const out of step.lines ?? []) {
    process.stdout.write((typeof out === "string" ? out : JSON.stringify(out)) + "\n");
  }
  if (step.exit !== undefined) process.exit(step.exit);
}
// After a prompt line: emit its entry, then chain any following entries that
// are not marked {"wait": true} (the real CLI streams the result unprompted;
// {"wait":true} entries only fire on the next stdin line — multi-turn tests).
function emitChain() {
  let step = script.shift() ?? { wait: true, lines: [] };
  emitStep(step);
  while (!step.wait && !step.exit && script[0] && !script[0].wait) {
    step = script.shift();
    emitStep(step);
  }
}
// Prologue: the first entry streams at startup (the real CLI emits init
// before reading any stdin — the client waits for it).
{
  const first = script.shift() ?? { lines: [] };
  emitStep(first);
  while (!first.wait && !first.exit && script[0] && !script[0].wait) {
    emitStep(script.shift());
  }
}

let rl = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  rl += d;
  let i;
  while ((i = rl.indexOf("\n")) >= 0) {
    const line = rl.slice(0, i).trim();
    rl = rl.slice(i + 1);
    if (!line) continue;
    if (traceFile) appendFileSync(traceFile, JSON.stringify({ line: JSON.parse(line) }) + "\n");
    emitChain();
  }
});
