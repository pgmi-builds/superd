/**
 * Env-tunable knobs.
 *
 * dsh-shape-session-log retired the union-era supervisor cadence and replay
 * cache knobs along with the supervisor and the union persistence.
 */
import { homedir } from "node:os";
import { join } from "node:path";


function parseMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Bridge-index tick: workspace attach + model-default sync + model refresh. */
export const STORAGE_RECONCILE_INTERVAL_MS = parseMs(process.env.OMP_STORAGE_RECONCILE_INTERVAL_MS, 30_000);

/**
 * Slash-command discovery refresh: the disk scan (omp+claude roots) re-mounts
 * the host `commands` registrations on this cadence — boot once, then hourly.
 * Pure disk reads, never a sidecar spawn. `0` disables the refresh.
 */
export const OMP_DISCOVERY_REFRESH_INTERVAL_MS = parseMs(
	process.env.OMP_DISCOVERY_REFRESH_INTERVAL_MS,
	3_600_000,
);
/**
 * The OMP home — the SDK runtime app home (`agentDir`): runtime data
 * (agent.db / models.db / sessions) and config live here. NATIVE by default
 * (user ruling 2026-09-17, pi precedent):
 *
 *     OMP_HOME = $OMP_HOME (tests / adapter-level isolation) ?? ~/.omp
 *
 * The installed OMP app keeps its own home; the adapter never redirects it at
 * spawn and never seeds config into it. `<dshHome>/agents/omp` remains the
 * world's DSH home (its sessions/storages/settings) — it is NOT the app home
 * anymore. The old nested derivation (`dshHomePath("agents", "omp", ".omp")`)
 * and the config copy-in (`ensureOmpAppHome`) are retired with the same
 * ruling; `OMP_HOME` stays overridable per the 2026-09-15 adapter-level
 * freedom (optional isolation, never the default).
 */
export const OMP_HOME = process.env.OMP_HOME ?? resolveOmpNativeHome();

/**
 * The operator's NATIVE OMP home (`~/.omp`): the TUI/CLI installation owning
 * `agent/config.yml`, `agent/models.yml` and the native session store. Since
 * the 2026-09-17 native-home ruling this is ALSO the default runtime app home
 * ({@link OMP_HOME}); the knob stays as a late env override seam (tests may
 * pin disk-scan roots via `$OMP_NATIVE_HOME` independently of `$OMP_HOME`).
 */
export function resolveOmpNativeHome(): string {
	return process.env.OMP_NATIVE_HOME ?? join(homedir(), ".omp");
}

/** Boot-time snapshot of {@link resolveOmpNativeHome}. */
export const OMP_NATIVE_HOME = resolveOmpNativeHome();
