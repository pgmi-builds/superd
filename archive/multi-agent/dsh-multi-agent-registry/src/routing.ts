/**
 * Runtime-key store (v2, 2026-09-09 user ruling: no side-table file).
 *
 * The registry keeps per-session routing keys in memory only. The set of
 * routable runtimes is NOT stored anywhere: it IS the registry's in-memory
 * factory map (Cordis service state — `appendFactory` registrations), exactly
 * the way the rest of the system discovers services through the context.
 *
 * Cross-restart durability is likewise not a registry-owned file. A foreign
 * runtime that owns sessions durably (its own session index / persistence)
 * exposes `ownsSession(sessionId)` on its factory; when the in-memory key is
 * absent (fresh process), delivery-time resolution probes registered foreign
 * factories and lets the owner claim the session. Each runtime remains the
 * single source of truth for what it owns — the registry invents no second
 * copy. Sessions nobody claims route to the `native` slot.
 */

/** In-memory routing keys: sessionId → runtime key. Lives with the process. */
const keys = new Map<string, string>()

/** Test seam: drop all in-memory keys. */
export function resetKeys(): void {
  keys.clear()
}

/**
 * Read the routing key for a session. `undefined` means "no key" — callers
 * treat that as: probe foreign ownership, else the `native` slot.
 */
export function readKey(sessionId: string): string | undefined {
  return keys.get(sessionId)
}

/** Write (or overwrite) the routing key for a session. */
export function writeKey(sessionId: string, key: string): void {
  keys.set(sessionId, key)
}

/** Remove the routing key for a session (absent key is a no-op). */
export function clearKey(sessionId: string): void {
  keys.delete(sessionId)
}
