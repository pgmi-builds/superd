/**
 * Codex home resolution + the rollout-HEAD metadata reader.
 *
 * The listing/replay scanner that used to live here is GONE (2026-09-16): the
 * DSH session log is now the session authority (upstream `sessionPersistence`
 * owns list/read/replay), so the adapter no longer derives session ids or
 * transcripts from Codex's rollout store. What remains is:
 *
 *  - home resolution (`<DSH home>/agents/codex`, spec S7) with the prod-home
 *  - home resolution (native `~/.codex`, never redirected) with the prod-home
 *  - {@link readRolloutHead}: a bounded, memoized reader of ONE rollout's
 *    FIRST line (`session_meta`), used only to recover the Codex system
 *    prompt (`payload.base_instructions`) and the recorded cwd. It never
 *    parses the transcript and never throws.
 *
 * Single-direction valve (spec S7): this module NEVER writes under the codex
 * home; the rollout stays Codex's transcript of record.
 */
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Prod homes that must never be resolved into (repo red line). */

/**
 * Resolve the Codex CLI's app-data home — the NATIVE `~/.codex` (user ruling
 * 2026-09-17, pi precedent): the installed app keeps its own home, so the
 * adapter never redirects it when spawning the SDK/CLI and never seeds config
 * into it. Precedence: `CODEX_HOME` (tests / operator override), then the
 * native default.
 *
 * The world's DSH home (`<dshHome>/agents/codex`) is NOT an input here anymore
 * — it anchors adapter-owned DSH state only (session-map.ts). A home without
 * `config.toml` would make the CLI fall back to OpenAI's own endpoint
 * (region-blocked here), but that is the operator's native home: provisioning
 * it is the operator's business (test helper: scripts/setup-codex-home.mjs).
 */
export function resolveCodexHome(): string {
  if (process.env.CODEX_HOME !== undefined) {
    const env = resolve(process.env.CODEX_HOME);
    return env;
  }
  const native = join(homedir(), ".codex");
  return native;
}

/**
 * Take an explicit codex home as-is (prod-guarded) — for callers that already
 * hold the final path (models.ts, the spike); distinct from
 * {@link resolveCodexHome}, which resolves the native default.
 */
export function useCodexHome(path: string): string {
  const resolved = resolve(path);
  return resolved;
}

/** The head-record fields this adapter reads (a subset of Codex's `session_meta`). */
export interface RolloutHead {
  /** Codex's thread id (`payload.id`), when the head parses. */
  readonly threadId?: string;
  /** Working directory recorded for the thread, when present. */
  readonly cwd?: string;
  /** Codex's own system prompt for the thread (`payload.base_instructions`). */
  readonly baseInstructions?: string;
}

/** Bounded read budget: `session_meta` is the FIRST line, so this is generous. */
const HEAD_BYTES = 64 * 1024;

/** Memoized heads by thread id — the head line is immutable once written. */
const headCache = new Map<string, RolloutHead>();

/**
 * Locate one thread's rollout file under `<codexHome>/sessions/<Y>/<M>/<D>/`.
 * The rollout file name embeds the thread id, so presence is the match test;
 * a miss is retried (a thread's rollout may not exist yet at first call).
 */
function findRolloutFile(codexHome: string, threadId: string): string | undefined {
  const root = join(codexHome, "sessions");
  try {
    for (const year of readdirSync(root, { withFileTypes: true })) {
      if (!year.isDirectory()) continue;
      for (const month of readdirSync(join(root, year.name), { withFileTypes: true })) {
        if (!month.isDirectory()) continue;
        for (const day of readdirSync(join(root, year.name, month.name), { withFileTypes: true })) {
          if (!day.isDirectory()) continue;
          const dir = join(root, year.name, month.name, day.name);
          for (const file of readdirSync(dir)) {
            if (file.endsWith(".jsonl") && file.includes(threadId)) return join(dir, file);
          }
        }
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Read (at most) the first line of a file; fail-soft. */
function readFirstLine(path: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    const chunk = Buffer.allocUnsafe(HEAD_BYTES);
    const read = readSync(fd, chunk, 0, chunk.length, 0);
    if (read <= 0) return undefined;
    const text = chunk.subarray(0, read).toString("utf8");
    const end = text.indexOf("\n");
    return end === -1 ? text : text.slice(0, end);
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/**
 * Read the `session_meta` head of the rollout belonging to `threadId`:
 * the Codex system prompt and the recorded cwd. Memoized per thread id (the
 * head line never changes); fail-soft — an unknown thread, an unwritten
 * rollout, or a malformed head all yield `undefined`.
 */
/**
 * Codex writes `payload.base_instructions` either as a plain string or as an
 * object `{ text }` (observed 2026-09-16 on the SDK line: the object form is
 * what the vendored binary emits today). Accept both; anything else is absent.
 */
function baseInstructionsText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() === "" ? undefined : value;
  if (value !== null && typeof value === "object") {
    const text = (value as { text?: unknown })["text"];
    if (typeof text === "string" && text.trim() !== "") return text;
  }
  return undefined;
}

export function readRolloutHead(codexHome: string, threadId: string): RolloutHead | undefined {
  const cached = headCache.get(threadId);
  if (cached !== undefined) return cached;
  const file = findRolloutFile(codexHome, threadId);
  if (file === undefined) return undefined;
  // Cheap existence/size gate before paying for a read.
  try {
    if (!statSync(file).isFile()) return undefined;
  } catch {
    return undefined;
  }
  const line = readFirstLine(file);
  if (line === undefined) return undefined;
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (record === null || typeof record !== "object") return undefined;
  const rec = record as Record<string, unknown>;
  if (rec["type"] !== "session_meta") return undefined;
  const payload = rec["payload"];
  if (payload === null || typeof payload !== "object") return undefined;
  const meta = payload as Record<string, unknown>;
  const head: RolloutHead = {
    ...(typeof meta["id"] === "string" && meta["id"] !== "" ? { threadId: meta["id"] } : {}),
    ...(typeof meta["cwd"] === "string" && meta["cwd"] !== "" ? { cwd: meta["cwd"] } : {}),
    ...(baseInstructionsText(meta["base_instructions"]) === undefined
      ? {}
      : { baseInstructions: baseInstructionsText(meta["base_instructions"]) as string }),
  };
  headCache.set(threadId, head);
  return head;
}

/** Test hygiene: drop memoized heads. */
export function clearRolloutHeadCache(): void {
  headCache.clear();
}

