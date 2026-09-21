/**
 * DSH-session ↔ Codex-thread identity map (the "mapping only" model,
 * 2026-09-16).
 *
 * The DSH session id is the authority: it is supplied by the harness at
 * create/resume and is what the API layer routes on. Codex's thread id only
 * materializes after the first turn, so the pairing is persisted here, in an
 * adapter-owned JSON file in the world's DSH home root (NOT inside the codex
 * app home — the app home is the CLI's native `~/.codex` since the 2026-09-17
 * home ruling; DSH bookkeeping never lives in the runtime's native tree):
 *
 *   `<worldHome>/dsh-sessions.json`   (`<DSH home>/agents/codex/dsh-sessions.json`)
 *
 * Shape: `{ "<dshSessionId>": { threadId, cwd, createdAt, preset } }` —
 * `threadId` is `null` until the Codex thread starts. Writes are atomic
 * (temp file + rename); reads are fail-soft (malformed JSON reads as empty)
 * and never throw, so a corrupt map degrades to "unknown session" rather
 * than breaking every operation.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { assertNotProdHome } from "./codex-store.js";

/** One persisted DSH → Codex session pairing. */
export interface CodexSessionRecord {
  /** Codex's thread id; `null` until the thread's first turn materializes it. */
  readonly threadId: string | null;
  /** The cwd the Codex thread was (or is to be) spawned in. */
  readonly cwd: string;
  /** Epoch ms of the DSH session's creation. */
  readonly createdAt: number;
  /** Launch-only approval preset recorded at create, when one was known. */
  readonly preset: string | null;
  /**
   * Sticky refusal flag: `false` once the native runtime rejects the
   * session's thread (missing rollout / rejected re-attach, plan RC-4), so a
   * later resume fails fast with the stable code instead of burning another
   * turn. Absent/`true` = no known refusal.
   */
  readonly resumable?: boolean;
}
/**
 * Stable resume-failure codes (plan RC-4/C1/C2): the code the factory throws
 * with so callers (and the hand-test matrix) can classify the failure without
 * parsing prose.
 */
/**
 * Stable resume-failure codes (plan RC-4/C1/C2): the code the factory throws
 * with so callers (and the hand-test matrix) can classify the failure without
 * parsing prose.
 */
export type CodexResumeErrorCode =
  /** The DSH session id has no map entry and no unique rollout match in the current codex home. */
  | "SESSION_MAP_MISS"
  /** The mapped thread's rollout is missing in the CURRENT codex home. */
  | "ROLLOUT_MISSING"
  /** The session never materialized a Codex thread (map records `threadId: null`). */
  | "NATIVE_THREAD_NEVER_STARTED"
  /** The native runtime refused the re-attach (or a prior turn-time resume was rejected). */
  | "NATIVE_REJECTED";

/** An `Error` carrying a stable {@link CodexResumeErrorCode}. */
export class CodexResumeError extends Error {
  readonly code: CodexResumeErrorCode;

  constructor(code: CodexResumeErrorCode, message: string) {
    super(message);
    this.name = "CodexResumeError";
    this.code = code;
  }
}

/** The whole map, keyed by DSH session id. */
export type CodexSessionMap = Record<string, CodexSessionRecord>;

/** The map file's path inside the adapter's app home. */
/**
 * The adapter's DSH-side state dir — the world's DSH home root
 * (`<dshHome>/agents/codex`), never the codex app home. Precedence: explicit
 * world home (boot-provided `dshHomePath`), then `$DSH_HOME` (a hub home, so
 * the world layout nests `agents/codex`), then the line's historical test-home
 * default. Prod-guarded.
 */
export function resolveCodexStateDir(home?: string): string {
  if (home !== undefined) {
    const dir = resolve(home);
    assertNotProdHome(dir, "codex state dir");
    return dir;
  }
  const fallbackHome = resolve(process.env.DSH_HOME ?? join(process.cwd(), ".tests", "aw"));
  const dir = join(fallbackHome, "agents", "codex");
  assertNotProdHome(dir, "codex state dir");
  return dir;
}

/** The map file's path at the world DSH-home root. */
export function sessionMapPath(home?: string): string {
  return join(resolveCodexStateDir(home), "dsh-sessions.json");
}

/** Read the map. Fail-soft: a missing or malformed file reads as `{}`. */
export function readSessionMap(home?: string): CodexSessionMap {
  let raw: string;
  try {
    raw = readFileSync(sessionMapPath(home), "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: CodexSessionMap = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    const record = coerceRecord(value);
    if (record !== undefined) out[id] = record;
  }
  return out;
}

/** Validate one entry; malformed entries are dropped (fail-soft). */
function coerceRecord(value: unknown): CodexSessionRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const cwd = raw["cwd"];
  const createdAt = raw["createdAt"];
  if (typeof cwd !== "string" || cwd === "") return undefined;
  const threadId = raw["threadId"];
  const preset = raw["preset"];
  return {
    threadId: typeof threadId === "string" && threadId !== "" ? threadId : null,
    cwd,
    createdAt: typeof createdAt === "number" && Number.isFinite(createdAt) ? createdAt : 0,
    preset: typeof preset === "string" && preset !== "" ? preset : null,
    ...(typeof raw["resumable"] === "boolean" ? { resumable: raw["resumable"] } : {}),
  };
}

/** One session's record, or `undefined` when the id is unknown. */
export function sessionRecord(home: string | undefined, dshSessionId: string): CodexSessionRecord | undefined {
  return readSessionMap(home)[dshSessionId];
}

/**
 * Insert or merge one session's record and persist the map atomically
 * (temp file + rename, same directory). Merge semantics: an omitted `patch`
 * field keeps the stored value; `threadId: null` explicitly records "not yet
 * materialized". Throws only when the write itself fails — the caller owns
 * that decision (create treats an unwritable map as fatal; the observation
 * path logs and continues).
 */
export function upsertSession(
  home: string | undefined,
  dshSessionId: string,
  patch: Partial<CodexSessionRecord>,
): CodexSessionRecord {
  const path = sessionMapPath(home);
  const map = readSessionMap(home);
  const previous = map[dshSessionId];
  const next: CodexSessionRecord = {
    threadId: patch.threadId !== undefined ? patch.threadId : previous?.threadId ?? null,
    cwd: patch.cwd !== undefined ? patch.cwd : previous?.cwd ?? "",
    createdAt: patch.createdAt !== undefined ? patch.createdAt : previous?.createdAt ?? Date.now(),
    preset: patch.preset !== undefined ? patch.preset : previous?.preset ?? null,
    // Sticky once false (an omitted patch keeps the stored refusal).
    ...(patch.resumable !== undefined
      ? { resumable: patch.resumable }
      : previous?.resumable === false
        ? { resumable: false }
        : {}),
  };
  map[dshSessionId] = next;
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(map, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    renameSync(temp, path);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // The rename failure is primary.
    }
    throw error;
  }
  return next;
}

/** Drop one session's record (idempotent; failure to persist rethrows). */
export function forgetSession(home: string | undefined, dshSessionId: string): void {
  const path = sessionMapPath(home);
  if (!existsSync(path)) return;
  const map = readSessionMap(home);
  if (map[dshSessionId] === undefined) return;
  delete map[dshSessionId];
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(map, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    renameSync(temp, path);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // The rename failure is primary.
    }
    throw error;
  }
}
