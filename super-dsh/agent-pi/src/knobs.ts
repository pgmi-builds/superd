/**
 * Env-tunable knobs (PI_TRACE / idle exit), mirroring the codex line's knobs.
 * pi's own process knobs (PI_CODING_AGENT_DIR etc.) are read by the pi SDK
 * itself — see pi-home.ts; this module only owns adapter-side behavior.
 */
export const PI_TRACE = process.env.PI_TRACE === "1";

/** Trace helper: `PI_TRACE=1` on the dsh process enables stderr tracing. */
export function trace(...parts: unknown[]): void {
  if (PI_TRACE) process.stderr.write(`[pi-provider ${Date.now() % 1_000_000}] ${parts.join(" ")}\n`);
}

function parseMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * How long an idle agent keeps its live pi AgentSession before teardown
 * (`PI_IDLE_EXIT_MS`). The next prompt cold-resumes through the recorded
 * native session file, so tearing down at idle costs nothing observable.
 * `0` disables the exit.
 */
export const PI_IDLE_EXIT_MS = parseMs(process.env.PI_IDLE_EXIT_MS, 600_000);
