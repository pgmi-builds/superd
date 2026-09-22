/**
 * pi-home — the adapter's DSH-side state-dir resolution.
 *
 * TWO homes, and mixing them is THE bug this module exists to prevent:
 *
 *  - pi's RUNTIME home is the native `~/.pi` (agent dir `~/.pi/agent`): auth,
 *    models, settings, skills, extensions, project trust, and the native
 *    session JSONL store all live there. The adapter NEVER redirects it — no
 *    `agentDir` override is passed to the SDK, so the user's pi CLI state is
 *    exactly what our sessions run with (2026-09-17 user ruling — generalized
 *    to ALL adapters in dev-rules §5/§13 the same day). Tests may
 *    redirect the RUNTIME home via `PI_CODING_AGENT_DIR` /
 *    `PI_CODING_AGENT_SESSION_DIR` — read by pi itself, never by us.
 *  - the adapter's DSH-side STATE dir is `<dshHomePath>/agents/pi`
 *    (om bridge-store / codex map precedent): the tiny dsh↔pi session mapping.
 *    pi never reads this tree; it is DSH bookkeeping in the same class as the
 *    DSH session log.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Prod homes that must never be resolved into (repo red line). */
const PROD_HOMES = [join(homedir(), ".dsh"), join(homedir(), ".superd")];

export function assertNotProdHome(path: string, label: string): void {
  if (process.env.SUPERD_DEV_REDLINE !== "1") return; // published install: the host dsh home (~/.dsh on consumers) is authoritative — the S3/S7 world layout lives under it. Dev lines set SUPERD_DEV_REDLINE=1 (repo red line: ~/.dsh is Dash prod).
  if (PROD_HOMES.includes(path) || PROD_HOMES.some((p) => path.startsWith(`${p}/`))) {
    throw new Error(`pi-home: refusing prod home as ${label}: ${path}`);
  }
}

/**
 * Resolve the adapter's DSH-side state dir — `<dshHomePath>/agents/pi`.
 * Precedence: explicit home (boot-provided `dshHomePath`), then `$DSH_HOME`,
 * then the line's historical test-home default. Prod-guarded.
 */
export function resolvePiStateDir(home?: string): string {
  if (home !== undefined) {
    const resolved = resolve(home);
    // World form: spawnWorld overrides dshHomePath to `<line home>/agents/pi`
    // — that tree IS the pi world's root, so the state dir is the home itself
    // (no second nest). Line/standalone form: nest once under agents/pi.
    if (resolved.endsWith(join("agents", "pi"))) {
      assertNotProdHome(resolved, "pi state dir");
      return resolved;
    }
    const dir = join(resolved, "agents", "pi");
    assertNotProdHome(dir, "pi state dir");
    return dir;
  }
  const fallbackHome = resolve(process.env.DSH_HOME ?? join(process.cwd(), ".tests", "aw"));
  const dir = join(fallbackHome, "agents", "pi");
  assertNotProdHome(dir, "pi state dir");
  return dir;
}

/** The dsh↔pi session mapping file inside the state dir. */
export function piMappingPath(home?: string): string {
  return join(resolvePiStateDir(home), "dsh-sessions.json");
}
