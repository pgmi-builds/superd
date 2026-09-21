/**
 * DSH-session ↔ Antigravity-conversation identity map (the "mapping only"
 * model, mirroring hermes-store.ts; 2026-09-18).
 *
 * The DSH session id is the authority. The SDK's `conversationId` only
 * materializes after the first turn (first bridge prompt), so the pairing is
 * persisted in the adapter's DSH-side app dir — `<worldHome>/dsh-sessions.json`
 * (never the runtime's native `~/.gemini`). Mapping only: resume resolves the
 * record or fails closed; native conversation storage is never scanned.
 *
 * Shape: `{ "<dshSessionId>": { conversationId, cwd, createdAt, preset } }` —
 * `conversationId` is `null` until the first turn materializes it.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** Prod homes that must never be resolved into (repo red line). */
const PROD_HOMES = [join(homedir(), ".dsh"), join(homedir(), ".superd")];

function assertNotProdHome(path: string, label: string): void {
  if (PROD_HOMES.includes(path) || PROD_HOMES.some((p) => path.startsWith(`${p}/`))) {
    throw new Error(`agy-sessions: refusing prod home as ${label}: ${path}`);
  }
}

/** One persisted DSH → Antigravity conversation pairing. */
export interface AgySessionRecord {
  /** The SDK conversation id; `null` until the first turn materializes it. */
  readonly conversationId: string | null;
  /** The cwd the bridge session was (or is to be) spawned in. */
  readonly cwd: string;
  /** Epoch ms of the DSH session's creation. */
  readonly createdAt: number;
  /** Record-only permission preset at create, when one was known. */
  readonly preset: string | null;
}

export type AgySessionMap = Record<string, AgySessionRecord>;

/**
 * The adapter's DSH-side world home. Form-A (boot home = DSH home root) nests
 * `agents/agy`; Form-B (already `<root>/agents/agy`) passes through. Prod-guarded.
 */
export function resolveAgyWorldHome(home?: string): string {
  const base = resolve(home ?? process.env.DSH_HOME ?? join(process.cwd(), ".tests", "aw"));
  const dir = basename(base) === "agy" && basename(dirname(base)) === "agents" ? base : join(base, "agents", "agy");
  assertNotProdHome(dir, "agy world home");
  return dir;
}

export function sessionMapPath(home?: string): string {
  return join(resolveAgyWorldHome(home), "dsh-sessions.json");
}

/** Read the map. Fail-soft: missing or malformed file reads as `{}`. */
export function readSessionMap(home?: string): AgySessionMap {
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
  const out: AgySessionMap = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    const record = coerceRecord(value);
    if (record !== undefined) out[id] = record;
  }
  return out;
}

function coerceRecord(value: unknown): AgySessionRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const cwd = raw["cwd"];
  const createdAt = raw["createdAt"];
  if (typeof cwd !== "string" || cwd === "") return undefined;
  const conversationId = raw["conversationId"];
  const preset = raw["preset"];
  return {
    conversationId: typeof conversationId === "string" && conversationId !== "" ? conversationId : null,
    cwd,
    createdAt: typeof createdAt === "number" && Number.isFinite(createdAt) ? createdAt : 0,
    preset: typeof preset === "string" && preset !== "" ? preset : null,
  };
}

/** One session's record, or `undefined` when the id is unknown. */
export function sessionRecord(home: string | undefined, dshSessionId: string): AgySessionRecord | undefined {
  return readSessionMap(home)[dshSessionId];
}

/** Insert or merge one record, persisted atomically (temp file + rename). */
export function upsertSession(
  home: string | undefined,
  dshSessionId: string,
  patch: Partial<AgySessionRecord>,
): AgySessionRecord {
  const path = sessionMapPath(home);
  const map = readSessionMap(home);
  const previous = map[dshSessionId];
  const next: AgySessionRecord = {
    conversationId: patch.conversationId !== undefined ? patch.conversationId : previous?.conversationId ?? null,
    cwd: patch.cwd !== undefined ? patch.cwd : previous?.cwd ?? "",
    createdAt: patch.createdAt !== undefined ? patch.createdAt : previous?.createdAt ?? Date.now(),
    preset: patch.preset !== undefined ? patch.preset : previous?.preset ?? null,
  };
  map[dshSessionId] = next;
  writeMapAtomic(path, map);
  return next;
}

function writeMapAtomic(path: string, map: AgySessionMap): void {
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
