/**
 * DSH-session ↔ Claude-session identity + permission-mode record (the "mapping
 * only" model, 2026-09-16; mirrors `agent-codex/src/session-map.ts`).
 *
 * Route A anchors the Claude session id deterministically from the DSH id's
 * UUID tail, so the *id* itself survives restarts with no map. What the event
 * log cannot round-trip is the **effective Claude permission mode**: the extra
 * tiers (`plan` / `auto` / `dontAsk`) are never folded into `permission/preset`
 * by `permissionEventsFor`, and `presetFromEvents` skips a `preset:"plan"`
 * event — so a resumed session cannot recover its live mode from the log. The
 * mode is therefore persisted HERE, in the same record that stores the
 * `claudeSessionId`, and `resume` reads it back and re-applies it through
 * `client.setPermissionMode(mode)`.
 *
 * The record is an adapter-owned JSON file at the world's DSH-home root (NOT
 * inside the Claude app home — the app home is the CLI's native `~/.claude`
 * since the 2026-09-17 home ruling; DSH bookkeeping never lives in the
 * runtime's native tree):
 *
 *   `<worldHome>/dsh-sessions.json`   (`<DSH home>/agents/claude/dsh-sessions.json`)
 *
 * Shape: `{ "<dshSessionId>": { claudeSessionId, claudeMode, cwd, createdAt,
 * preset } }`. Writes are atomic (temp file + rename); reads are fail-soft
 * (malformed JSON reads as empty) and never throw, so a corrupt map degrades
 * to "unknown session" rather than breaking every operation.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** One persisted DSH → Claude session pairing. */
export interface ClaudeSessionRecord {
  /** Claude's session id (route A tail, or null until route B resolves it). */
  readonly claudeSessionId: string | null;
  /** The effective Claude permission mode at create / last switch. */
  readonly claudeMode: string | null;
  /** Sticky refusal flag: a native "conversation not found" marks the pairing
   *  dead — later prompts fail fast instead of burning another turn. Absent =
   *  resumable; an explicit `true` clears it (2026-09-18 user ruling: ignore
   *  such sessions, never resurrect them). */
  readonly resumable?: boolean;
  /** The cwd the Claude CLI was (or is to be) spawned in. */
  readonly cwd: string;
  /** Epoch ms of the DSH session's creation. */
  readonly createdAt: number;
  /** The DSH permission preset resolved at create, when one was known. */
  readonly preset: string | null;
}

/** The whole map, keyed by DSH session id. */
export type ClaudeSessionMap = Record<string, ClaudeSessionRecord>;

/**
 * The adapter's DSH-side state dir — the world's DSH home root
 * (`<dshHome>/agents/claude`), never the Claude app home. Precedence:
 * explicit world home (boot-provided `dshHomePath`), then `$DSH_HOME` (a hub
 * home, so the world layout nests `agents/claude`), then the line's
 * historical test-home default.
 */
export function resolveClaudeStateDir(home?: string): string {
  if (home !== undefined) {
    const dir = resolve(home);
    return dir;
  }
  const fallbackHome = resolve(process.env.DSH_HOME ?? join(process.cwd(), ".tests", "aw"));
  const dir = join(fallbackHome, "agents", "claude");
  return dir;
}

/** The map file's path at the world DSH-home root. */
export function sessionMapPath(home?: string): string {
  return join(resolveClaudeStateDir(home), "dsh-sessions.json");
}

/** Read the map. Fail-soft: a missing or malformed file reads as `{}`. */
export function readSessionMap(home?: string): ClaudeSessionMap {
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
  const out: ClaudeSessionMap = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    const record = coerceRecord(value);
    if (record !== undefined) out[id] = record;
  }
  return out;
}

/** Validate one entry; malformed entries are dropped (fail-soft). */
function coerceRecord(value: unknown): ClaudeSessionRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const cwd = raw["cwd"];
  if (typeof cwd !== "string" || cwd === "") return undefined;
  const claudeSessionId = raw["claudeSessionId"];
  const claudeMode = raw["claudeMode"];
  const preset = raw["preset"];
  const createdAt = raw["createdAt"];
  return {
    claudeSessionId: typeof claudeSessionId === "string" && claudeSessionId !== "" ? claudeSessionId : null,
    claudeMode: typeof claudeMode === "string" && claudeMode !== "" ? claudeMode : null,
    cwd,
    createdAt: typeof createdAt === "number" && Number.isFinite(createdAt) ? createdAt : 0,
    preset: typeof preset === "string" && preset !== "" ? preset : null,
    ...(raw["resumable"] === false ? { resumable: false } : {}),
  };
}

/** One session's record, or `undefined` when the id is unknown. */
export function sessionRecord(home: string | undefined, dshSessionId: string): ClaudeSessionRecord | undefined {
  return readSessionMap(home)[dshSessionId];
}

/**
 * Insert or merge one session's record and persist the map atomically (temp
 * file + rename, same directory). Merge semantics: an omitted `patch` field
 * keeps the stored value; `claudeSessionId: null` explicitly records "not yet
 * resolved". Throws only when the write itself fails — the caller owns that
 * decision (create treats an unwritable map as fatal).
 */
export function upsertSession(
  home: string | undefined,
  dshSessionId: string,
  patch: Partial<ClaudeSessionRecord>,
): ClaudeSessionRecord {
  const path = sessionMapPath(home);
  const map = readSessionMap(home);
  const previous = map[dshSessionId];
  const next: ClaudeSessionRecord = {
    claudeSessionId: patch.claudeSessionId !== undefined ? patch.claudeSessionId : previous?.claudeSessionId ?? null,
    claudeMode: patch.claudeMode !== undefined ? patch.claudeMode : previous?.claudeMode ?? null,
    cwd: patch.cwd !== undefined ? patch.cwd : previous?.cwd ?? "",
    createdAt: patch.createdAt !== undefined ? patch.createdAt : previous?.createdAt ?? Date.now(),
    preset: patch.preset !== undefined ? patch.preset : previous?.preset ?? null,
    // Sticky refusal: only an explicit `true` clears a recorded false.
    ...(patch.resumable === true ? {} : patch.resumable === false || previous?.resumable === false ? { resumable: false } : {}),
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
