/**
 * AW-E Task 1 spike (P0 gate): prove `@openai/codex-sdk@0.154.0` drives a real
 * turn against the local cc-switch provider (glm-5.2) under an ISOLATED
 * CODEX_HOME, and capture the raw ThreadEvent chain for the Task 2 projection
 * fixtures. The SDK spawns its own exact-pinned codex binary — the 0.153.4
 * CLI on PATH is never consulted (version-mix safety, 2026-09-10 fact).
 */
import { Codex } from "@openai/codex-sdk";

export interface SpikeResult {
  threadId: string;
  finalResponse: string;
  usage: unknown;
  events: unknown[];
}

function lastOfType<T extends { type: string }>(events: unknown[], type: string): T | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const evt = events[i] as T;
    if (evt.type === type) return evt;
  }
  return undefined;
}

/** Run one real streamed turn and collect the full event chain. */
export async function runSpike(opts: {
  codexHome: string;
  cwd: string;
  prompt?: string;
}): Promise<SpikeResult> {
  const codex = new Codex({
    // env REPLACES process.env (SDK contract) — carry it forward + redirect home.
    env: { ...process.env, CODEX_HOME: opts.codexHome } as Record<string, string>,
  });
  const thread = codex.startThread({
    workingDirectory: opts.cwd,
    skipGitRepoCheck: true,
    approvalPolicy: "never",
    sandboxMode: "read-only",
  });
  const events: unknown[] = [];
  const streamed = await thread.runStreamed(opts.prompt ?? "Reply with exactly: ok");
  for await (const evt of streamed.events) {
    events.push(evt);
    if (evt.type === "turn.failed") {
      const error = (evt as { error?: { message?: string } }).error;
      throw new Error(`spike turn failed: ${error?.message ?? "unknown"}`);
    }
  }
  const completed = lastOfType<{ type: string; usage?: unknown }>(events, "turn.completed");
  const message = lastOfType<{ type: string; item?: { type?: string; text?: string } }>(events, "item.completed");
  return {
    threadId: thread.id ?? "",
    finalResponse: message?.item?.text ?? "",
    usage: completed?.usage ?? null,
    events,
  };
}
