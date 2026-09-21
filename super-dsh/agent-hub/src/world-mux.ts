/**
 * Per-world Remote stream mux server (AW-B DL6).
 *
 * Upstream's `RemoteStreamMuxServer` owns `/api/remote.mux` for the native
 * gateway and is NOT reachable from outside its package (root exports omit it;
 * `./src/*` cannot be imported at runtime). So this is our own wire-compatible
 * implementation of the same protocol, bound to the ADDRESSED world's
 * `openWireStream`:
 *
 *   browser → server   { type:'open', streamId, endpoint, payload }
 *                      { type:'cancel', streamId }
 *   server → browser   { type:'item', streamId, value }
 *                      { type:'end', streamId }
 *                      { type:'error', streamId, error:{code,message,details} }
 *
 * Heartbeat: ping every interval, terminate after two missed pongs (same
 * policy as upstream).
 */

/** Open one world stream (the world gateway's `openWireStream`). */
export type MuxOpen = (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<AsyncIterable<unknown>>

/** Wire failure body (upstream `RemoteStreamFailure`). */
export interface MuxFailure {
  code: string
  message: string
  details: object
}

/** Options. */
export interface WorldMuxOptions {
  /** Ping interval; upstream default is 30s. */
  heartbeatIntervalMs?: number
  /** Error → wire failure mapper. */
  failure?: (error: unknown) => MuxFailure
}

/** One client request frame. */
type ClientMessage =
  | { type: 'open'; streamId: string; endpoint: string; payload: unknown }
  | { type: 'cancel'; streamId: string }

/** Minimal structural view of the `ws` surface we use. */
interface WsSocketLike {
  readyState: number
  send(text: string, callback: (error?: Error) => void): void
  close(code?: number, reason?: string): void
  terminate(): void
  ping(): void
  on(event: string, listener: (...args: unknown[]) => void): void
  once(event: string, listener: (...args: unknown[]) => void): void
}
interface WsServerLike {
  readonly clients: Set<WsSocketLike>
  handleUpgrade(req: unknown, socket: unknown, head: Buffer, callback: (socket: WsSocketLike) => void): void
  close(callback?: (error?: Error) => void): void
}
interface WsModuleLike {
  WebSocketServer: new (options: { noServer: true }) => WsServerLike
  WebSocket: { OPEN: number }
}

/** Specifier is widened on purpose: `ws` is a runtime peer, not a typed dep. */
const WS_MODULE: string = 'ws'
const MAX_MISSED_HEARTBEATS = 2
const DEFAULT_HEARTBEAT_MS = 30_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value)
  return own.length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * Parse one browser text frame.
 * @param text - complete WebSocket text message.
 * @returns the validated request.
 * @throws {Error} on a malformed frame.
 */
export function parseClientMessage(text: string): ClientMessage {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('world-mux: invalid client message')
  }
  if (!isRecord(raw)) throw new Error('world-mux: invalid client message')
  if (raw['type'] === 'cancel' && exactKeys(raw, ['type', 'streamId']) && validId(raw['streamId'])) {
    return { type: 'cancel', streamId: raw['streamId'] }
  }
  if (raw['type'] === 'open'
    && exactKeys(raw, ['type', 'streamId', 'endpoint', 'payload'])
    && validId(raw['streamId'])
    && typeof raw['endpoint'] === 'string'
    && raw['endpoint'].length > 0) {
    return { type: 'open', streamId: raw['streamId'], endpoint: raw['endpoint'], payload: raw['payload'] }
  }
  throw new Error('world-mux: invalid client message')
}

/** Default failure mapper: keep the error code when it looks like one. */
export function defaultFailure(error: unknown): MuxFailure {
  if (isRecord(error)) {
    const code = typeof error['code'] === 'string' ? error['code'] : undefined
    const message = typeof error['message'] === 'string' ? error['message'] : undefined
    if (code !== undefined) return { code, message: message ?? code, details: {} }
  }
  return { code: 'gateway/stream-error', message: error instanceof Error ? error.message : String(error), details: {} }
}

interface ActiveStream {
  readonly abort: AbortController
  done: Promise<void>
}

/** One world's mux endpoint. */
export class WorldMuxServer {
  private server: WsServerLike | undefined
  private ws: WsModuleLike | undefined
  private heartbeat: NodeJS.Timeout | undefined
  private readonly connections = new Set<Promise<void>>()
  private readonly missed = new WeakMap<object, number>()
  private closed = false

  constructor(
    private readonly open: MuxOpen,
    private readonly options: WorldMuxOptions = {},
  ) { }

  /** Take over one accepted upgrade request. */
  async handleUpgrade(req: unknown, socket: unknown, head: Buffer): Promise<void> {
    const { server, ws } = await this.load()
    server.handleUpgrade(req, socket, head, (client) => {
      this.missed.set(client as object, 0)
      client.on('pong', () => { this.missed.set(client as object, 0) })
      this.startHeartbeat()
      const done = this.runConnection(client, ws)
      this.connections.add(done)
      void done.then(() => { this.connections.delete(done) })
    })
  }

  /** Terminate every socket and wait for the active streams to unwind. */
  async close(): Promise<void> {
    this.closed = true
    clearInterval(this.heartbeat)
    this.heartbeat = undefined
    const server = this.server
    if (server !== undefined) {
      for (const client of server.clients) client.terminate()
      await new Promise<void>((resolve) => { server.close(() => resolve()) })
    }
    await Promise.all([...this.connections])
  }

  private async load(): Promise<{ server: WsServerLike; ws: WsModuleLike }> {
    if (this.server !== undefined && this.ws !== undefined) return { server: this.server, ws: this.ws }
    const mod = (await import(WS_MODULE)) as unknown as WsModuleLike & { default?: WsModuleLike }
    const ws = typeof mod.WebSocketServer === 'function' ? mod : (mod.default as WsModuleLike)
    const server = new ws.WebSocketServer({ noServer: true })
    this.server = server
    this.ws = ws
    return { server, ws }
  }

  private async runConnection(client: WsSocketLike, ws: WsModuleLike): Promise<void> {
    const streams = new Map<string, ActiveStream>()
    let writes = Promise.resolve()
    const send = (message: unknown): Promise<void> => {
      let text: string
      try {
        text = JSON.stringify(message)
      } catch (cause) {
        return Promise.reject(new Error('world-mux: item is not JSON serializable', { cause }))
      }
      const delivery = writes.then(() => new Promise<void>((resolve, reject) => {
        if (client.readyState !== ws.WebSocket.OPEN) {
          reject(new Error('world-mux: socket is closed'))
          return
        }
        client.send(text, (error) => { if (error) reject(error); else resolve() })
      }))
      writes = delivery.catch(() => undefined)
      return delivery
    }
    const pump = async (streamId: string, endpoint: string, payload: unknown, active: ActiveStream): Promise<void> => {
      try {
        const source = await this.open(endpoint, payload, active.abort.signal)
        for await (const value of source) {
          await send({ type: 'item', streamId, value })
        }
        if (!active.abort.signal.aborted) await send({ type: 'end', streamId })
      } catch (error) {
        if (!active.abort.signal.aborted && client.readyState === ws.WebSocket.OPEN) {
          const failure = (this.options.failure ?? defaultFailure)(error)
          try {
            await send({ type: 'error', streamId, error: failure })
          } catch {
            client.close(1011, 'Remote stream failure could not be delivered')
          }
        }
      }
    }
    await new Promise<void>((resolve) => {
      client.once('close', () => { resolve() })
      client.on('error', () => { client.terminate() })
      client.on('message', (data: unknown, isBinary?: unknown) => {
        if (isBinary === true) {
          client.close(1003, 'text messages required')
          return
        }
        let message: ClientMessage
        try {
          message = parseClientMessage(String(data))
        } catch {
          client.close(1008, 'invalid Remote stream request')
          return
        }
        if (message.type === 'cancel') {
          streams.get(message.streamId)?.abort.abort(new Error('Remote stream cancelled'))
          return
        }
        if (streams.has(message.streamId)) {
          client.close(1008, 'duplicate Remote stream id')
          return
        }
        const abort = new AbortController()
        const active: ActiveStream = { abort, done: Promise.resolve() }
        streams.set(message.streamId, active)
        const done = pump(message.streamId, message.endpoint, message.payload, active)
        active.done = done
        void done.then(() => streams.delete(message.streamId), () => streams.delete(message.streamId))
      })
    })
    const active = [...streams.values()]
    for (const stream of active) stream.abort.abort(new Error('Remote stream socket closed'))
    await Promise.all(active.map(stream => stream.done))
  }

  private startHeartbeat(): void {
    if (this.heartbeat !== undefined || this.closed) return
    const interval = this.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS
    this.heartbeat = setInterval(() => {
      const server = this.server
      if (server === undefined) return
      for (const client of server.clients) {
        if (client.readyState !== (this.ws?.WebSocket.OPEN ?? 1)) continue
        const missed = this.missed.get(client as object) ?? 0
        if (missed >= MAX_MISSED_HEARTBEATS) {
          client.terminate()
          continue
        }
        this.missed.set(client as object, missed + 1)
        client.ping()
      }
    }, interval)
    this.heartbeat.unref()
  }
}
