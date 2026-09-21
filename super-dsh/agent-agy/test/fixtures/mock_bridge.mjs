#!/usr/bin/env node
/**
 * mock_bridge.mjs — test double for bridge/agy_bridge.py, same JSONL contract.
 * AGY_MOCK_SCRIPT = JSON array; entries consumed one per received request:
 *   {"events":[{...},...], "exit"?:code, "sleep"?:ms}
 * Each received request line is appended to AGY_MOCK_TRACE (if set) so tests
 * can assert the exact request sequence (op/text/api_key).
 */
import { appendFileSync } from "node:fs";

const script = JSON.parse(process.env.AGY_MOCK_SCRIPT ?? "[]");
const traceFile = process.env.AGY_MOCK_TRACE;

let rl = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  rl += d;
  let i;
  while ((i = rl.indexOf("\n")) >= 0) {
    const line = rl.slice(0, i).trim();
    rl = rl.slice(i + 1);
    if (!line) continue;
    const req = JSON.parse(line);
    if (traceFile) appendFileSync(traceFile, JSON.stringify(req) + "\n");
    const step = script.shift() ?? { events: [] };
    const write = () => {
      for (const ev of step.events ?? []) {
        process.stdout.write(JSON.stringify(ev) + "\n");
      }
      if (step.exit !== undefined) process.exit(step.exit);
    };
    if (step.sleep) setTimeout(write, step.sleep);
    else write();
  }
});
