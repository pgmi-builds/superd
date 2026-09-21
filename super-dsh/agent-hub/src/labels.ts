/**
 * Label table (AW-B DL2/DL4): one world ↔ one mount path under the ctx0 origin.
 *
 * The addressed world is the request's path (`/<label>/...`), so the label is
 * the ONLY routing key. Reserving it must be atomic against the real
 * webServer's duplicate-registration throw — that throw is the only collision
 * signal the framework offers (the route tables are private and there is no
 * query API), so it is used here as the probe.
 *
 * A collision is a composition-level conflict and must be loud; an optional
 * alternate root lets a deployment re-home instead of failing to boot.
 */

/** One reserved mount path. */
export interface LabelClaim {
  /** Runtime key (`omp`, `codex`, …). */
  readonly key: string
  /** Reserved mount root, e.g. `/omp` or `/_agents/omp` (no trailing slash). */
  readonly path: string
  /** Release the claim (idempotent). */
  release(): void
}

/** How to reserve a path: the injected real-webServer registration. */
export interface ClaimOptions {
  /** Attempt a prefix registration; throws when `(kind, path)` is already taken. */
  register(path: string): () => void
  /** Optional root prefix (default: the origin root). */
  root?: string
  /** Candidate roots to try, in order, when the clean path is taken. */
  alternateRoots?: readonly string[]
}

const claims = new Map<string, LabelClaim>()

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Reject keys that cannot be a single path segment. */
function assertKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key === '' || key.includes('/') || key.includes('?')) {
    throw new Error(`labels: invalid label key ${JSON.stringify(key)} (one non-empty path segment required)`)
  }
}

function joinRoot(root: string, key: string): string {
  const trimmed = root.replace(/\/+$/, '')
  return trimmed === '' ? `/${key}` : `${trimmed}/${key}`
}

/**
 * Reserve the mount path for `key`.
 * @param key - runtime key (one path segment).
 * @param opts - registration probe plus optional roots.
 * @returns the live claim.
 */
export function claimLabel(key: string, opts: ClaimOptions): LabelClaim {
  assertKey(key)
  const existing = claims.get(key)
  if (existing !== undefined) {
    throw new Error(`labels: key ${JSON.stringify(key)} already claimed at "${existing.path}"`)
  }
  const roots = [opts.root ?? '', ...(opts.alternateRoots ?? [])]
  const tried: string[] = []
  for (const root of roots) {
    const path = joinRoot(root, key)
    if (tried.includes(path)) continue
    tried.push(path)
    let dispose: (() => void) | undefined
    try {
      dispose = opts.register(path)
    } catch {
      continue
    }
    const claim: LabelClaim = {
      key,
      path,
      release: () => {
        if (claims.get(key)?.path !== path) return
        claims.delete(key)
        dispose?.()
      },
    }
    claims.set(key, claim)
    return claim
  }
  throw new Error(
    `labels: no free mount path for ${JSON.stringify(key)} (tried ${tried.map(p => `"${p}"`).join(', ')})`,
  )
}

/** The reserved mount root for a key, or undefined when unclaimed. */
export function labelOf(key: string): string | undefined {
  return claims.get(key)?.path
}

/** Release a key's claim; unknown keys are a no-op. */
export function releaseLabel(key: string): void {
  claims.get(key)?.release()
}

/** Claimed keys, registration order. */
export function listLabels(): string[] {
  return [...claims.keys()]
}

/** Test/introspection helper: is this object a claim? */
export function isLabelClaim(value: unknown): value is LabelClaim {
  return isRecordLike(value) && typeof value['key'] === 'string' && typeof value['path'] === 'string'
}
