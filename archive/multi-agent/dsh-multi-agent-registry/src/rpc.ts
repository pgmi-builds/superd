/**
 * Runtime-key RPC face (M1 Task 5).
 *
 * Auth conclusion (upstream source, 2026-09-09): every upstream `/api/*`
 * feature (session-log-export, the shared `/api` channel itself) mounts via
 * `ctx.connection.fetch.register(...)` — the client-connection service owns
 * the single `/api` prefix webServer route and runs the Host/Origin
 * browser-trust fence + persistent browser auth (`requestRejection`) before
 * dispatching to any registered Fetch route. Registering our own
 * `webServer` route at `/api/agent-runtime` would bypass that fence (the
 * webserver's longest-prefix-wins match would hand the request to us, never
 * to client-connection), i.e. weaken it. So we mirror session-log-export:
 * mount through `connection.fetch.register`, which inherits the fence
 * automatically. No fence is weakened; none is duplicated.
 */

import type { Context } from '@deepseek-ai/cordis'
import { readKey, writeKey } from './routing.js'

/** The shared-channel Fetch route path this RPC face owns. */
export const AGENT_RUNTIME_RPC_PATH = '/api/agent-runtime'

/** Minimal registry face this RPC reads (the runtime key IS its concern). */
export interface RuntimeKeySource {
  /** Registered factory keys, including `native` when the native loop is loaded. */
  listFactories(): string[]
}

/** Structural type of `ctx.connection.fetch` (upstream: HostConnectionFetch). */
interface ConnectionFetchFace {
  register(route: {
    path: string
    methods: readonly ('GET' | 'HEAD' | 'POST')[]
    requestBody: 'buffered'
    fetch: (request: Request) => Promise<Response>
  }): () => Promise<void>
}

/** Compute the `available` list: `native` plus every registered key. */
export function availableRuntimes(source: RuntimeKeySource): string[] {
  return ['native', ...source.listFactories().filter((key) => key !== 'native')]
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function handle(request: Request, source: RuntimeKeySource): Promise<Response> {
  const url = new URL(request.url)
  if (request.method === 'GET') {
    const sessionId = url.searchParams.get('sessionId')
    if (sessionId === null || sessionId === '') return json(400, { error: 'sessionId query parameter is required' })
    return json(200, {
      sessionId,
      runtime: readKey(sessionId) ?? 'native',
      available: availableRuntimes(source),
    })
  }
  // POST
  let payload: unknown
  try {
    payload = JSON.parse(await request.text())
  } catch {
    return json(400, { error: 'body must be valid JSON' })
  }
  const { sessionId, runtime } = (payload ?? {}) as { sessionId?: unknown; runtime?: unknown }
  if (typeof sessionId !== 'string' || sessionId === '') return json(400, { error: 'sessionId (string) is required' })
  if (typeof runtime !== 'string' || runtime === '') return json(400, { error: 'runtime (string) is required' })
  if (!availableRuntimes(source).includes(runtime)) {
    return json(400, { error: `unknown runtime "${runtime}"`, available: availableRuntimes(source) })
  }
  writeKey(sessionId, runtime)
  return json(200, { sessionId, runtime, available: availableRuntimes(source) })
}

/**
 * Register the runtime-key RPC face on the shared `/api` connection channel
 * (behind the standard browser-trust + auth fence). No-op when the
 * `connection` service is absent (e.g. fake-ctx unit tests).
 */
export function registerRuntimeKeyRpc(ctx: Context, source: RuntimeKeySource): void {
  ctx.inject(['connection'], (connCtx) => {
    const fetchFace = (Reflect.get(connCtx, 'connection') as { fetch?: ConnectionFetchFace } | undefined)?.fetch
    if (fetchFace === undefined) return // connection not actually present (test ctx)
    connCtx.effect(() => fetchFace.register({
      path: AGENT_RUNTIME_RPC_PATH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: (request) => handle(request, source),
    }), 'multi-agent-registry: /api/agent-runtime route')
  })
}
