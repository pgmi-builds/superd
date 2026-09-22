/**
 * DSH-session ↔ Hermes-gateway-session identity map (the "mapping only"
 * model, 2026-09-17).
 *
 * The DSH session id is the authority: it is supplied by the harness at
 * create/resume and is what the API layer routes on. The gateway's session id
 * only materializes after the first prompt, so the pairing is persisted here,
 * in an adapter-owned JSON file in the hermes world's DSH-side app dir (NOT
 * hermes data — the hermes runtime keeps its native `~/.hermes` home since the
 * 2026-09-17 user ruling; DSH bookkeeping never lives in the runtime's native
 * tree):
 *
 *   `<appDir>/dsh-sessions.json`   (`<DSH home>/agents/hermes/dsh-sessions.json`)
 *
 * Shape: `{ "<dshSessionId>": { gatewaySessionId, cwd, createdAt, preset } }` —
 * `gatewaySessionId` is `null` until the gateway session materializes (the
 * first prompt is pending). Writes are atomic (temp file + rename); reads are
 * fail-soft (malformed JSON reads as empty) and never throw, so a corrupt map
 * degrades to "unknown session" rather than breaking every operation.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** Prod homes that must never be resolved into (repo red line). */
const PROD_HOMES = [join(homedir(), ".dsh"), join(homedir(), ".superd")];

function assertNotProdHome(path: string, label: string): void {
  if (process.env.SUPERD_DEV_REDLINE !== "1") return; // published install: the host dsh home (~/.dsh on consumers) is authoritative — the S3/S7 world layout lives under it. Dev lines set SUPERD_DEV_REDLINE=1 (repo red line: ~/.dsh is Dash prod).
  if (PROD_HOMES.includes(path) || PROD_HOMES.some((p) => path.startsWith(`${p}/`))) {
    throw new Error(`hermes-store: refusing prod home as ${label}: ${path}`);
  }
}

/** One persisted DSH → Hermes session pairing. */
export interface HermesSessionRecord {
  /** The gateway's session id; `null` until the first prompt materializes it. */
  /** The gateway's LIVE (ephemeral) session id; `null` until the first prompt. */
  readonly gatewaySessionId: string | null;
  /** The gateway's DURABLE state.db key (`stored_session_id`), the resume authority across restarts. */
  readonly gatewayStoredSessionId: string | null;
  /** The cwd the gateway session was (or is to be) spawned in. */
  readonly cwd: string;
  /** Epoch ms of the DSH session's creation. */
  readonly createdAt: number;
  /** Launch-only approval preset recorded at create, when one was known. */
  readonly preset: string | null;
}

/** The whole map, keyed by DSH session id. */
export type HermesSessionMap = Record<string, HermesSessionRecord>;

/**
 * The adapter's DSH-side state dir — `<dshHome>/agents/hermes`. This is DSH-SIDE
 * adapter state (the identity map), NOT hermes data: hermes keeps its native
 * `~/.hermes` home (user ruling 2026-09-17) and this module never touches it.
 *
 * Two forms (2026-09-17 r2 fix):
 *   - Form-A: the boot-provided home (or `$DSH_HOME`) is the DSH home ROOT —
 *     the per-agent world dir is NESTED, so the map lands at
 *     `<root>/agents/hermes/dsh-sessions.json`.
 *   - Form-B: the boot-provided home is ALREADY the world home
 *     (`<root>/agents/hermes`) — passed through as-is, never double-nested.
 * Precedence: explicit home (boot-provided `dshHomePath`), then `$DSH_HOME`,
 * then the line's historical test-home default. Prod-guarded.
 */
export function resolveHermesAppDir(home?: string): string {
  const base = resolve(home ?? process.env.DSH_HOME ?? join(process.cwd(), ".tests", "aw"));
  // Form-B world home is already `<root>/agents/hermes` — never double-nest.
  const dir = basename(base) === "hermes" && basename(dirname(base)) === "agents" ? base : join(base, "agents", "hermes");
  assertNotProdHome(dir, "hermes app dir");
  return dir;
}

/** The map file's path inside the adapter's DSH-side app dir. */
export function sessionMapPath(home?: string): string {
  return join(resolveHermesAppDir(home), "dsh-sessions.json");
}

/** Read the map. Fail-soft: a missing or malformed file reads as `{}`. */
export function readSessionMap(home?: string): HermesSessionMap {
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
  const out: HermesSessionMap = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    const record = coerceRecord(value);
    if (record !== undefined) out[id] = record;
  }
  return out;
}

/** Validate one entry; malformed entries are dropped (fail-soft). */
function coerceRecord(value: unknown): HermesSessionRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const cwd = raw["cwd"];
  const createdAt = raw["createdAt"];
  if (typeof cwd !== "string" || cwd === "") return undefined;
  const gatewaySessionId = raw["gatewaySessionId"];
  const gatewayStoredSessionId = raw["gatewayStoredSessionId"];
  const preset = raw["preset"];
  return {
    gatewaySessionId: typeof gatewaySessionId === "string" && gatewaySessionId !== "" ? gatewaySessionId : null,
    gatewayStoredSessionId: typeof gatewayStoredSessionId === "string" && gatewayStoredSessionId !== "" ? gatewayStoredSessionId : null,
    cwd,
    createdAt: typeof createdAt === "number" && Number.isFinite(createdAt) ? createdAt : 0,
    preset: typeof preset === "string" && preset !== "" ? preset : null,
  };
}

/** One session's record, or `undefined` when the id is unknown. */
export function sessionRecord(home: string | undefined, dshSessionId: string): HermesSessionRecord | undefined {
  return readSessionMap(home)[dshSessionId];
}

/**
 * Insert or merge one session's record and persist the map atomically
 * (temp file + rename, same directory). Merge semantics: an omitted `patch`
 * field keeps the stored value; `gatewaySessionId: null` explicitly records
 * "not yet materialized" (first prompt pending). Throws only when the write
 * itself fails — the caller owns that decision (create treats an unwritable
 * map as fatal; the observation path logs and continues).
 */
export function upsertSession(
  home: string | undefined,
  dshSessionId: string,
  patch: Partial<HermesSessionRecord>,
): HermesSessionRecord {
  const path = sessionMapPath(home);
  const map = readSessionMap(home);
  const previous = map[dshSessionId];
  const next: HermesSessionRecord = {
    gatewaySessionId: patch.gatewaySessionId !== undefined ? patch.gatewaySessionId : previous?.gatewaySessionId ?? null,
    gatewayStoredSessionId: patch.gatewayStoredSessionId !== undefined ? patch.gatewayStoredSessionId : previous?.gatewayStoredSessionId ?? null,
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
  const path = sessionMapPath(home);
  if (!existsSync(path)) return;
  const map = readSessionMap(home);
  if (map[dshSessionId] === undefined) return;
  delete map[dshSessionId];
  writeMapAtomic(path, map);
}

/** Atomic persist: temp file (mode 0600) + same-directory rename. */
function writeMapAtomic(path: string, map: HermesSessionMap): void {
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
}
