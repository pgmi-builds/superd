/**
 * Connection unary envelope (AW-B DL5).
 *
 * Our carrier owns `/<label>/api/*` and therefore must speak the wire shape
 * itself. The shape is fixed by upstream (`client/connection/src/rpc-host.ts`):
 *
 *   request   { type: 'client-request',  rpcId, method, payload }
 *   response  { type: 'server-response', rpcId, result: { ok: true, value } }
 *             { type: 'server-response', rpcId, result: { ok: false, error } }
 *
 * Endpoint segments follow upstream's pattern so a crafted path cannot smuggle
 * anything the native route would have rejected.
 */

/** One decoded client request. */
export interface ClientRequestEnvelope {
  /** Correlates the response; echoed verbatim. */
  rpcId: string
  /** Typert endpoint (the gateway's dispatch key). */
  method: string
  /** Invocation payload. */
  payload: unknown
}

/** One wire error body. */
export interface WireError {
  code: string
  message: string
  details?: unknown
}

/** Upstream's endpoint segment pattern (`rpc-host.ts`). */
export const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

/** Envelope-level failure carrying the wire error to answer with. */
export class EnvelopeError extends Error {
  constructor(readonly wire: WireError) {
    super(wire.message)
    this.name = 'EnvelopeError'
  }
}

function badRequest(message: string): never {
  throw new EnvelopeError({ code: 'gateway/bad-request', message })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Decode one request body.
 * @param text - raw body text.
 * @returns the decoded envelope.
 * @throws {EnvelopeError} when the body is not a valid client-request.
 */
export function parseClientRequest(text: string): ClientRequestEnvelope {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    badRequest('invalid client-request message')
  }
  if (!isRecord(raw)) badRequest('invalid client-request message')
  if (raw['type'] !== 'client-request') badRequest('invalid client-request message')
  const rpcId = raw['rpcId']
  const method = raw['method']
  if (typeof rpcId !== 'string' || rpcId === '') badRequest('invalid client-request message')
  if (typeof method !== 'string' || method === '') badRequest('invalid client-request message')
  const segments = method.split('/')
  if (segments.some(segment => segment === '' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    badRequest('invalid client-request message')
  }
  return { rpcId, method, payload: raw['payload'] }
}

/** Serialize a successful server response from a raw value. */
export function serverResponse(rpcId: string, value: unknown): string {
  return JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value } })
}

/**
 * Serialize a server response whose `result` is already a gateway Result
 * (`{ ok: true, value }` | `{ ok: false, error }`). The typert gateway's
 * `dispatchRpc` returns exactly that shape, so it is copied verbatim.
 */
export function serverResult(rpcId: string, result: unknown): string {
  return JSON.stringify({ type: 'server-response', rpcId, result })
}

/** Serialize a failed server response. */
export function serverError(rpcId: string, error: WireError): string {
  return JSON.stringify({ type: 'server-response', rpcId, result: { ok: false, error } })
}

/** Normalize an unknown thrown value into a wire error. */
export function wireErrorOf(error: unknown): WireError {
  if (error instanceof EnvelopeError) return error.wire
  if (isRecord(error)) {
    const code = typeof error['code'] === 'string' ? error['code'] : undefined
    const message = typeof error['message'] === 'string' ? error['message'] : undefined
    if (code !== undefined) {
      return { code, message: message ?? code, ...(error['details'] === undefined ? {} : { details: error['details'] }) }
    }
  }
  return {
    code: 'gateway/internal-error',
    message: error instanceof Error ? error.message : String(error),
  }
}
