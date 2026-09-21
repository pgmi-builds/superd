/**
 * Foreign target registry: which runtime key maps to which context's
 * typertGateway SERVICE INSTANCE.
 *
 * The instance is the whole target: its two methods (dispatchRpc /
 * openWireStream) address their upstream through their own owning context
 * (ctx.typert, ctx.reflect) and their own instance state (remoteEvents,
 * registered by that tree's api-remotes). Delegating a call to the instance
 * therefore delegates BOTH address spaces at once — Cordis ctx and JS this.
 * An out-of-process target (subprocess app / remote machine) implements the
 * same GatewayFace over the wire (ADR 0007 loopback relay) — the caller
 * cannot tell the difference.
 */

/** The structural face of a typertGateway service instance. */
export interface GatewayFace {
  dispatchRpc(endpoint: string, payload: unknown, signal: AbortSignal): Promise<unknown>
  openWireStream(endpoint: string, payload: unknown, signal: AbortSignal): AsyncIterable<unknown>
}

/** One addressable runtime world behind the selector. */
export interface ForeignTarget {
  /** Runtime key (`omp`, …) — what the selector addresses. */
  key: string
  /** The context's typertGateway service instance (or a wire adapter with the same face). */
  gateway: GatewayFace
}

const targets = new Map<string, ForeignTarget>()

/** Register (or replace) the target for a runtime key. */
export function registerForeignTarget(target: ForeignTarget): void {
  targets.set(target.key, target)
}

/** Drop a target (context disposed). */
export function unregisterForeignTarget(key: string): void {
  targets.delete(key)
}

/** Live runtime keys: the native world plus every registered foreign key. */
export function listRuntimeKeys(): string[] {
  return ['native', ...targets.keys()]
}

/** Test/introspection hook. */
export function getTarget(key: string): ForeignTarget | undefined {
  return targets.get(key)
}
