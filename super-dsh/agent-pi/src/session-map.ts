/**
 * DSH-session ↔ pi-session-file identity map (the "mapping only" model,
 * codex precedent).
 *
 * The DSH session id is the authority: it is supplied by the harness at
 * create/resume and is what the API layer routes on. pi's session file only
 * materializes when the first prompt starts the SDK session, so the pairing
 * is persisted here, in an adapter-owned JSON file in the adapter's DSH-side
 * state dir (2026-09-17 ruling — pi's native home `~/.pi` stays pi-only):
 *
 *   `<dshHome>/agents/pi/dsh-sessions.json`
 *
 * Shape: `{ "<dshSessionId>": { sessionFile, cwd, createdAt, preset } }` —
 * `sessionFile` is `null` until the pi session starts. Writes are atomic
 * (temp file + rename); reads are fail-soft (malformed JSON reads as empty)
 * and never throw, so a corrupt map degrades to "unknown session" rather
 * than breaking every operation.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { piMappingPath } from "./pi-home.js";

/** One persisted DSH → pi session pairing. */
export interface PiSessionRecord {
  /**
   * pi's native session JSONL path; `null` until the SDK session's first
   * prompt materializes it.
   */
  readonly sessionFile: string | null;
  /** The cwd the pi session was (or is to be) started in. */
  readonly cwd: string;
  /** Epoch ms of the DSH session's creation. */
  readonly createdAt: number;
  /** Launch-only permission preset recorded at create, when one was known. */
  readonly preset: string | null;
}

/** The whole map, keyed by DSH session id. */
export type PiSessionMap = Record<string, PiSessionRecord>;

/** Read the map. Fail-soft: a missing or malformed file reads as `{}`. */
export function readSessionMap(home?: string): PiSessionMap {
  let raw: string;
  try {
    raw = readFileSync(piMappingPath(home), "utf8");
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
  const out: PiSessionMap = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    const record = coerceRecord(value);
    if (record !== undefined) out[id] = record;
  }
  return out;
}

/** Validate one entry; malformed entries are dropped (fail-soft). */
function coerceRecord(value: unknown): PiSessionRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const cwd = raw["cwd"];
  const createdAt = raw["createdAt"];
  if (typeof cwd !== "string" || cwd === "") return undefined;
  const sessionFile = raw["sessionFile"];
  const preset = raw["preset"];
  return {
    sessionFile: typeof sessionFile === "string" && sessionFile !== "" ? sessionFile : null,
    cwd,
    createdAt: typeof createdAt === "number" && Number.isFinite(createdAt) ? createdAt : 0,
    preset: typeof preset === "string" && preset !== "" ? preset : null,
  };
}

/** One session's record, or `undefined` when the id is unknown. */
export function sessionRecord(home: string | undefined, dshSessionId: string): PiSessionRecord | undefined {
  return readSessionMap(home)[dshSessionId];
}

/**
 * Insert or merge one session's record and persist the map atomically
 * (temp file + rename, same directory). Merge semantics: an omitted `patch`
 * field keeps the stored value; `sessionFile: null` explicitly records "not
 * yet materialized". Throws only when the write itself fails — the caller
 * owns that decision (create treats an unwritable map as fatal; the
 * observation path logs and continues).
 */
export function upsertSession(
  home: string | undefined,
  dshSessionId: string,
  patch: Partial<PiSessionRecord>,
): PiSessionRecord {
  const path = piMappingPath(home);
  const map = readSessionMap(home);
  const previous = map[dshSessionId];
  const next: PiSessionRecord = {
    sessionFile: patch.sessionFile !== undefined ? patch.sessionFile : previous?.sessionFile ?? null,
    cwd: patch.cwd !== undefined ? patch.cwd : previous?.cwd ?? "",
    createdAt: patch.createdAt !== undefined ? patch.createdAt : previous?.createdAt ?? Date.now(),
    preset: patch.preset !== undefined ? patch.preset : previous?.preset ?? null,
  };
  map[dshSessionId] = next;
  writeMapAtomic(path, map);
  return next;
}

/** Drop one session's record (idempotent; failure to persist rethrows). */
export function forgetSession(home: string | undefined, dshSessionId: string): void {
  const path = piMappingPath(home);
  if (!existsSync(path)) return;
  const map = readSessionMap(home);
  if (map[dshSessionId] === undefined) return;
  delete map[dshSessionId];
  writeMapAtomic(path, map);
}

function writeMapAtomic(path: string, map: PiSessionMap): void {
  mkdirSync(dirname(path), { recursive: true });
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
