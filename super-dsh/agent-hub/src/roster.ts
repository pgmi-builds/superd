/**
 * Foreign agent roster (S2: plugin-presence IS the roster).
 *
 * No config file: an agent is in the roster exactly while its adapter
 * plugin is loaded and registered. Adapter plugins self-register on
 * activation (key/label/ready) and the RuntimeSeat chip consumes the
 * snapshot. Roster entries are inventory only: they carry NO selection —
 * the addressed world is the request's mount path (`DL7`, 2026-09-16).
 * one authority.
 */
export interface RosterEntry {
  /** Runtime key (`omp`, `codex`, …) — what the selector addresses. */
  key: string
  /** Human label for the selector chip. */
  label: string
  /** True once the adapter's world context is spawned and its target registered. */
  ready: boolean
}

const entries = new Map<string, RosterEntry>()
const listeners = new Set<(entries: RosterEntry[]) => void>()

function emit(): void {
  const snap = listAgents()
  for (const fn of listeners) fn(snap)
}

/** Register an agent. Duplicate keys are a plugin bug — throw loud. */
export function registerAgent(entry: RosterEntry): void {
  if (entries.has(entry.key)) throw new Error(`roster: duplicate agent key ${entry.key}`)
  entries.set(entry.key, { ...entry })
  emit()
}

/** Drop an agent (adapter plugin disposed). */
export function unregisterAgent(key: string): void {
  entries.delete(key)
  emit()
}

/** Flip readiness (world spawned / disposed). Unknown keys are a plugin bug. */
export function setReady(key: string, ready: boolean): void {
  const e = entries.get(key)
  if (!e) throw new Error(`roster: unknown agent ${key}`)
  e.ready = ready
  emit()
}

/** Snapshot copy — callers can hold it without aliasing the roster. */
export function listAgents(): RosterEntry[] {
  return [...entries.values()].map((e) => ({ ...e }))
}

/** Subscribe to roster changes; returns an unsubscribe function. */
export function onRosterChanged(fn: (entries: RosterEntry[]) => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
