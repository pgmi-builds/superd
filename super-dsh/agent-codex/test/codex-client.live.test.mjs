// Task 3 Step 3: live integration test — REAL codex turn through CodexSdkClient
// under the worktree's nested CODEX_HOME. GATED: runs only with
// AW_CODEX_LIVE=1 because a real turn costs provider tokens (glm via
// cc-switch). Kept to ONE short turn ("Reply with exactly: ok"); the
// fixture/fake-driven path in codex-client.test.mjs validates the seam
// otherwise.
import test from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { CodexSdkClient } from "../dist/codex-client.js";

const PKG = new URL("..", import.meta.url).pathname;
const WT = resolve(join(PKG, "..", ".."));
const HOME = process.env.DSH_HOME ?? join(WT, ".tests");

test(
  "live: real codex turn through CodexSdkClient under the nested CODEX_HOME",
  { skip: process.env.AW_CODEX_LIVE !== "1" && "set AW_CODEX_LIVE=1" },
  async () => {
    const client = await CodexSdkClient.spawn([], PKG);
    let assistantText = "";
    const done = new Promise((resolveDone) => {
      client.on((event) => {
        if (event.type === "message_end") {
          const message = event.message ?? {};
          if (message.role === "assistant" && Array.isArray(message.content)) {
            const text = message.content.find((block) => block.type === "text")?.text;
            if (typeof text === "string" && text !== "") assistantText = text;
          }
        }
        if (event.type === "agent_end") resolveDone(assistantText);
      });
    });
    await client.prompt("Reply with exactly: ok");
    const text = await done;
    assert.match(text, /ok/, "final assistant message echoes the prompt contract");
    assert.deepEqual(await client.getState(), { isStreaming: false });
    const stats = await client.getSessionStats();
    assert.ok(typeof stats.tokens === "object", "turn usage captured");
    client.close();
  },
);
