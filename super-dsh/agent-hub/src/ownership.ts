/**
 * Session → world ownership index (AW-B DL9/DL10).
 *
 * The mount path addresses the world for UI traffic, but a session-scoped
 * caller (resume, export, a deep link) may only carry a sessionId. Resolving it
 * must be O(1) and must NEVER degrade into a probe waterfall: a miss triggers
 * AT MOST one bounded refresh (in-flight refreshes coalesce), and a miss after
 * that refresh is a miss — the caller fails where it asked instead of asking
 * every world in turn.
 */

/** One ownership row returned by a refresh. */
export interface OwnershipRow {
  sessionId: string
  /** Runtime key (`native`, `omp`, …). */
  key: string
}

/** The ownership index surface. */
export interface OwnershipIndex {
  /** Record (or overwrite) one ownership. */
  set(sessionId: string, key: string): void
  /** Drop one ownership (session deleted). */
  forget(sessionId: string): void
  /** Synchronous lookup; performs NO refresh. */
  lookup(sessionId: string): string | undefined
  /** Lookup, then at most one bounded refresh, then lookup again. */
  resolve(sessionId: string): Promise<string | undefined>
  /** Current index size (diagnostics/tests). */
  size(): number
  /** Drop everything (world roster replaced). */
  clear(): void
}

/**
 * Create an ownership index.
 * @param refresh - optional bounded re-read of the ownership rows.
 * @returns the index.
 */
export function createOwnershipIndex(
  refresh?: () => Promise<readonly OwnershipRow[]>,
): OwnershipIndex {
  const owners = new Map<string, string>()
  let inflight: Promise<void> | undefined

  const runRefresh = (): Promise<void> => {
    if (inflight !== undefined) return inflight
    const started = (async () => {
      const rows = refresh === undefined ? [] : await refresh()
      for (const row of rows) owners.set(row.sessionId, row.key)
    })()
    inflight = started.finally(() => { inflight = undefined })
    return inflight
  }

  return {
    set(sessionId, key) {
      owners.set(sessionId, key)
    },
    forget(sessionId) {
      owners.delete(sessionId)
    },
    lookup(sessionId) {
      return owners.get(sessionId)
    },
    async resolve(sessionId) {
      const hit = owners.get(sessionId)
      if (hit !== undefined) return hit
      await runRefresh()
      return owners.get(sessionId)
    },
    size() {
      return owners.size
    },
    clear() {
      owners.clear()
    },
  }
}
