/**
 * ctx0 WebCarrier (AW-B DL1/DL5): mounts one world's traffic under `/<label>`.
 *
 * Responsibilities (grow per AW-B task):
 *  - Task 4: unary RPC — `/<label>/api/<endpoint>` decodes the connection
 *    envelope and dispatches into the ADDRESSED world's gateway instance.
 *  - Task 6: mux — `/<label>/api/remote.mux` upgrade bridged to the same
 *    instance (no shared selection anywhere).
 *  - 2026-09-17 (H1): non-envelope GET/HEAD on `/<label>/api` forwards into
 *    the owning world's registered exact Fetch routes — the world connection's
 *    shared `/api` handler, published from `world-entry` via `world-host` —
 *    still behind ctx0's fence, so `HEAD /<label>/api/session.export?...`
 *    reaches the world's session-log-download route.
 *
 * The addressed world is the request's path. Nothing here reads a global.
 */
import {
  EnvelopeError,
  parseClientRequest,
  serverError,
  serverResult,
  wireErrorOf,
} from './envelope.js'
import { stripLabelFromUrl, type RealWebServerFace, type WorldRequest, type WorldResponse } from './world-web-server.js'
import { worldFetchHandlerOf } from './world-host.js'
import { WorldMuxServer, type MuxFailure } from './world-mux.js'

/** The two-method face of a world's typertGateway service instance. */
export interface CarrierGatewayFace {
  dispatchRpc(endpoint: string, payload: unknown, signal: AbortSignal): Promise<unknown>
  /** Streams return an async iterable (upstream face is synchronous-returning). */
  openWireStream(endpoint: string, payload: unknown, signal: AbortSignal): Promise<AsyncIterable<unknown>> | AsyncIterable<unknown>
}

/** Options for mounting one world. */
export interface MountWorldOptions {
  /** The ctx0 webServer the translated routes register on. */
  real: RealWebServerFace
  /** Runtime key: the mount label (`omp` → `/omp`). */
  label: string
  /** The addressed world's gateway instance. */
  gateway: CarrierGatewayFace
  /** ctx0's browser-trust fence: returns an HTTP status to reject with. */
  requestRejection?(req: unknown): number | undefined
  /** Max request body bytes (mirrors the connection default). */
  maxBodyBytes?: number
  /** Mux ping interval (upstream default 30s). */
  heartbeatIntervalMs?: number
  /** Error → wire failure mapper for the world's streams. */
  failure?(error: unknown): MuxFailure
}

/** The live mount handle. */
export interface MountedWorld {
  /** Mount root (`/omp`). */
  readonly labelPath: string
  /** Unary channel root (`/omp/api`). */
  readonly apiPath: string
  /** Mux websocket path (`/omp/api/remote.mux`). */
  readonly muxPath: string
  /** Unregister everything this mount installed. */
  dispose(): void
}

/** Default body cap, aligned with the connection service. */
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024

interface BodyCarrier {
  [Symbol.asyncIterator]?(): AsyncIterator<unknown>
  on?(event: 'data' | 'end' | 'error', listener: (chunk?: unknown) => void): unknown
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown
}

async function readBody(req: unknown, limit: number): Promise<string> {
  const carrier = req as BodyCarrier
  const chunks: Buffer[] = []
  let size = 0
  if (typeof carrier[Symbol.asyncIterator] === 'function') {
    for await (const chunk of carrier as AsyncIterable<unknown>) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      size += buf.byteLength
      if (size > limit) throw new EnvelopeError({ code: 'gateway/bad-request', message: 'request body too large' })
      chunks.push(buf)
    }
    return Buffer.concat(chunks).toString('utf8')
  }
  if (typeof carrier.on !== 'function') return ''
  return await new Promise<string>((resolve, reject) => {
    carrier.on?.('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''))
      size += buf.byteLength
      if (size > limit) {
        reject(new EnvelopeError({ code: 'gateway/bad-request', message: 'request body too large' }))
        return
      }
      chunks.push(buf)
    })
    carrier.on?.('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    carrier.on?.('error', (error) => reject(error instanceof Error ? error : new Error(String(error))))
  })
}

/** Reject an upgrade on the raw socket (no ws ownership transfer). */
function rejectUpgrade(socket: unknown, status: 401 | 403): void {
  const reason = status === 401 ? 'Unauthorized' : 'Forbidden'
  const body = reason.toLowerCase()
  const writable = socket as { write?: (chunk: string) => unknown; destroy?: () => void; end?: () => void }
  writable.write?.(
    `HTTP/1.1 ${status} ${reason}\r\n`
    + 'Connection: close\r\n'
    + 'Content-Type: text/plain; charset=utf-8\r\n'
    + `Content-Length: ${String(Buffer.byteLength(body, 'utf8'))}\r\n\r\n`
    + body,
  )
  writable.destroy?.()
}

function writeJson(res: WorldResponse, status: number, body: string): void {
  const carrier = res as WorldResponse & { writeHead?: (status: number, headers?: Record<string, string>) => void }
  carrier.writeHead?.(status, { 'content-type': 'application/json' })
  res.end(body)
}

/** Write a plain-text answer (the shape upstream's own 404/413 answers use). */
function writeText(res: WorldResponse, status: number, body: string): void {
  const carrier = res as WorldResponse & { writeHead?: (status: number, headers?: Record<string, string>) => void }
  carrier.writeHead?.(status, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(body)
}

/**
 * Mount one world on the shared ctx0 webServer.
 * @param options - see {@link MountWorldOptions}.
 * @returns the live mount handle.
 */
export function mountWorld(options: MountWorldOptions): MountedWorld {
  const labelPath = `/${options.label}`
  const apiPath = `${labelPath}/api`
  const muxPath = `${apiPath}/remote.mux`
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const disposers: Array<() => void> = []

  const forwardsFetchMethod = (req: WorldRequest): boolean => {
    const method = (req as { method?: unknown }).method
    return method === 'GET' || method === 'HEAD'
  }

  /**
   * Forward one non-envelope GET/HEAD request into the owning world's shared
   * `/api` fetch handler (exact Fetch routes first, then the gateway's RPC
   * interceptor, then 404 — the upstream composition). The ctx0 fence has
   * already answered by the time we get here; the world's own browser-auth
   * gate is never consulted (a different tree, a different secret).
   */
  const bridgeWorldFetch = async (req: WorldRequest, res: WorldResponse): Promise<void> => {
    const worldFetch = worldFetchHandlerOf(options.label)
    if (worldFetch === undefined) {
      writeText(res, 404, 'not found')
      return
    }
    const method = ((req as { method?: unknown }).method ?? 'GET') as string
    const resCarrier = res as WorldResponse & {
      write?(chunk: unknown): boolean
      once?(event: string, listener: () => void): unknown
      off?(event: string, listener: () => void): unknown
      destroy?(): void
      readonly writableEnded?: boolean
    }
    // Client-disconnect detection rides the response (same reason as the
    // upstream node:http bridge: the request 'close' fires as soon as a
    // bodyless GET is consumed).
    const abort = new AbortController()
    const onClose = (): void => {
      if (resCarrier.writableEnded !== true) abort.abort()
    }
    resCarrier.once?.('close', onClose)
    let headersSent = false
    try {
      const headers: Record<string, string> = {}
      for (const [name, value] of Object.entries((req as { headers?: Record<string, unknown> }).headers ?? {})) {
        if (typeof value === 'string') headers[name.toLowerCase()] = value
      }
      // The world route owns the world-relative URL: strip the mount label,
      // keep the query (the session-export route reads it from searchParams).
      const request = new Request(
        new URL(stripLabelFromUrl(req.url, labelPath), 'http://dsh.internal'),
        { method, headers, signal: abort.signal },
      )
      const response = await worldFetch.fetch(request)
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
      headersSent = true
      if (response.body === null) {
        res.end()
        return
      }
      for await (const chunk of response.body) {
        // Backpressure: wait for drain instead of buffering unboundedly; a
        // socket close resolves the wait and the aborted signal ends the stream.
        if (resCarrier.write?.(chunk) === false && typeof resCarrier.once === 'function') {
          await new Promise<void>((resolve) => {
            const done = (): void => {
              resCarrier.off?.('drain', done)
              resCarrier.off?.('close', done)
              resolve()
            }
            resCarrier.once?.('drain', done)
            resCarrier.once?.('close', done)
          })
        }

      }
      res.end()
    } catch {
      // The world route owns its statuses; only carrier-level faults land here.
      if (!headersSent) writeText(res, 500, 'carrier fetch bridge failure')
      else resCarrier.destroy?.()
    } finally {
      resCarrier.off?.('close', onClose)
    }
  }

  const handleUnary = async (req: WorldRequest, res: WorldResponse): Promise<void> => {
    const rejection = options.requestRejection?.(req)
    if (rejection !== undefined) {
      writeJson(res, rejection, JSON.stringify({ error: rejection === 401 ? 'unauthorized' : 'forbidden' }))
      return
    }
    let rpcId = 'invalid-request'
    try {
      const text = await readBody(req, maxBody)
      let envelope: ReturnType<typeof parseClientRequest>
      try {
        envelope = parseClientRequest(text)
      } catch (error) {
        // Non-envelope GET/HEAD traffic on the shared mount prefix belongs to
        // the world's own registered fetch routes; envelopes (and every other
        // method) keep the transport-level 400 below.
        if (error instanceof EnvelopeError && forwardsFetchMethod(req)) {
          await bridgeWorldFetch(req, res)
          return
        }
        throw error
      }
      rpcId = envelope.rpcId
      const controller = new AbortController()
      const result = await options.gateway.dispatchRpc(envelope.method, envelope.payload, controller.signal)
      // The gateway already returns a Result (`{ok:true,value}` | `{ok:false,error}`),
      // which is exactly the server-response's `result` field.
      writeJson(res, 200, serverResult(rpcId, result))
    } catch (error) {
      const wire = wireErrorOf(error)
      // Envelope-level failures are transport-level 400s; dispatch failures are
      // business results carried inside a 200 server-response (upstream shape).
      if (error instanceof EnvelopeError) {
        writeJson(res, 400, serverError(rpcId, wire))
        return
      }
      writeJson(res, 200, serverError(rpcId, wire))
    }
  }

  disposers.push(options.real.register({
    kind: 'prefix',
    path: apiPath,
    handler: handleUnary as never,
  }))

  // Mux: the world's own stream face behind the same mount prefix.
  const mux = new WorldMuxServer(
    (endpoint, payload, signal) => Promise.resolve(options.gateway.openWireStream(endpoint, payload, signal)),
    {
      ...(options.heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
      ...(options.failure === undefined ? {} : { failure: options.failure }),
    },
  )
  disposers.push(options.real.registerUpgrade({
    path: muxPath,
    handler: ((req: WorldRequest, socket: unknown, head: Buffer) => {
      const rejection = options.requestRejection?.(req)
      if (rejection !== undefined) {
        rejectUpgrade(socket, rejection === 401 ? 401 : 403)
        return
      }
      return mux.handleUpgrade(req, socket, head)
    }) as never,
  }))
  disposers.push(() => { void mux.close().catch(() => undefined) })

  return {
    labelPath,
    apiPath,
    muxPath,
    dispose(): void {
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          dispose()
        } catch {
          // teardown must not throw
        }
      }
    },
  }
}

// The mount HTML pass lives in its own module; re-exported here so the carrier
// remains the single import surface for mount behaviour.
export { rewriteIndexHtml } from './index-pass.js'
