/**
 * Control-plane RPC face for the agents hub (DL7: NO server-side selection).
 *
 * Auth conclusion (upstream source, inherited from the shelved route): every
 * upstream `/api/*` feature mounts via `ctx.connection.fetch.register(...)` —
 * the client-connection service owns the single `/api` prefix webServer route
 * and runs the Host/Origin browser-trust fence + persistent browser auth
 * before dispatching. Registering our own webServer route would bypass that
 * fence; we mount through `connection.fetch` and inherit it.
 *
 * This face is superd-owned control traffic and is ALWAYS answered by CTX0:
 * it reports which worlds exist. It carries no selection: world ownership is
 * per-request and travels on the mount path (`/<label>/...`, see carrier.ts),
 * so two tabs on two worlds cannot step on each other.
 */
import type { Context } from '@deepseek-ai/cordis'
import { listRuntimeKeys } from './targets.js'
import { agentLinks } from './agent-roster.js'

/** The shared-channel Fetch route path this RPC face owns. */
export const AGENT_RUNTIME_RPC_PATH = '/api/agent-runtime'

/** What the RPC reads to compute the `available` list. */
export interface RuntimeTargetSource {
  /** Registered runtime keys, including `native`. */
  listRuntimes(): string[]
}

/** The live registry view: native plus every registered foreign context. */
export const registryTargets: RuntimeTargetSource = {
  listRuntimes: listRuntimeKeys,
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

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * The control-plane handler: world inventory only.
 * @param request - the incoming `/api/agent-runtime` request.
 * @param source - live runtime registry view.
 * @returns the JSON response.
 */
export async function handleAgentRuntime(
  request: Request,
  source: RuntimeTargetSource,
): Promise<Response> {
  const available = source.listRuntimes()
  if (request.method === 'GET' || request.method === 'HEAD') {
    // The selector asks this face for the roster: keys AND the mount path each
    // key is addressed by. Read-only — the roster carries no selection.
    return json(200, { available, agents: agentLinks() })
  }
  // A POST that used to switch a global selector has no meaning any more:
  // the addressed world is the mount path of the request, not a shared value.
  return json(400, {
    error: 'selection is per-request (mount path); no server-side switch',
    available,
  })
}

/**
 * Register the control-plane RPC face on the shared `/api` connection channel
 * (behind the standard browser-trust + auth fence). No-op when the
 * `connection` service is absent (e.g. fake-ctx unit tests).
 */
export function registerSelectorRpc(ctx: Context, source: RuntimeTargetSource): void {
  ctx.inject(['connection'], (connCtx) => {
    const fetchFace = (Reflect.get(connCtx, 'connection') as { fetch?: ConnectionFetchFace } | undefined)?.fetch
    if (fetchFace === undefined) return // connection not actually present (test ctx)
    connCtx.effect(() => fetchFace.register({
      path: AGENT_RUNTIME_RPC_PATH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: (request) => handleAgentRuntime(request, source),
    }), 'agent-hub: /api/agent-runtime route')
  })
}
