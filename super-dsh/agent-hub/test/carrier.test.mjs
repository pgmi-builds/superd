// WebCarrier unary bridge (AW-B DL5): `/<label>/api/<endpoint>` decodes the
// connection envelope and lands on the ADDRESSED world's gateway instance.
// Nothing here consults a shared selection value.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mountWorld } from '../dist/carrier.js'

function fakeReal() {
  return {
    routes: new Map(),
    upgrades: new Map(),
    fallback: undefined,
    register(route) {
      const id = `${route.kind}:${route.path}`
      if (this.routes.has(id)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
      this.routes.set(id, route)
      return () => this.routes.delete(id)
    },
    registerUpgrade(route) { this.upgrades.set(route.path, route); return () => this.upgrades.delete(route.path) },
    registerFallback(handler) { this.fallback = handler; return () => { this.fallback = undefined } },
    tapIndex() { return () => { } },
    port: 4999,
    host: '127.0.0.1',
  }
}

function fakeRes() {
  return {
    status: 0,
    headers: undefined,
    body: undefined,
    chunks: [],
    writeHead(status, headers) { this.status = status; this.headers = headers },
    write(chunk) { this.chunks.push(chunk); return true },
    end(body) { this.body = body },
  }

}

function reqWith(body, url = '/omp/api/session.list') {
  return {
    url,
    method: 'POST',
    headers: {},
    async *[Symbol.asyncIterator]() { yield Buffer.from(body) },
  }
}

function worldGateway(result = { ok: true, value: 'v' }) {
  const calls = []
  return {
    calls,
    async dispatchRpc(endpoint, payload, signal) { calls.push({ endpoint, payload, aborted: signal.aborted }); return result },
  }
}

async function callMounted(mounted, real, body, url = '/omp/api/session.list') {
  const handler = real.routes.get(`prefix:${mounted.apiPath}`).handler
  const res = fakeRes()
  await handler(reqWith(body, url), res)
  return res
}

test('unary decodes the envelope, dispatches to the world instance, answers one server-response', async () => {
  const real = fakeReal()
  const gateway = worldGateway()
  const mounted = mountWorld({ real, label: 'omp', gateway })
  const res = await callMounted(mounted, real, JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session.list', payload: { a: 1 } }))
  assert.deepEqual(gateway.calls, [{ endpoint: 'session.list', payload: { a: 1 }, aborted: false }])
  assert.equal(res.status, 200)
  assert.deepEqual(JSON.parse(res.body), { type: 'server-response', rpcId: 'r1', result: { ok: true, value: 'v' } })
  mounted.dispose()
})

test('invalid envelopes answer 400 and never reach the world', async () => {
  const real = fakeReal()
  const gateway = worldGateway()
  const mounted = mountWorld({ real, label: 'omp', gateway })
  const bad = await callMounted(mounted, real, 'not json')
  assert.equal(bad.status, 400)
  const body = JSON.parse(bad.body)
  assert.equal(body.result.ok, false)
  assert.equal(body.result.error.code, 'gateway/bad-request')
  const wrongType = await callMounted(mounted, real, JSON.stringify({ type: 'nope', rpcId: 'x', method: 'm' }))
  assert.equal(wrongType.status, 400)
  assert.equal(gateway.calls.length, 0, 'no cross-world wire call on a malformed request')
  mounted.dispose()
})

test('a dispatch failure is a 200 server-response carrying the error', async () => {
  const real = fakeReal()
  const gateway = {
    async dispatchRpc() {
      return { ok: false, error: { code: 'session/not-found', message: 'no such session' } }
    },
  }
  const mounted = mountWorld({ real, label: 'omp', gateway })
  const res = await callMounted(mounted, real, JSON.stringify({ type: 'client-request', rpcId: 'r2', method: 'session.list', payload: {} }))
  assert.equal(res.status, 200)
  assert.deepEqual(JSON.parse(res.body).result, { ok: false, error: { code: 'session/not-found', message: 'no such session' } })
  mounted.dispose()
})

test('a thrown error becomes an error result on 200 (business failure, not transport failure)', async () => {
  const real = fakeReal()
  const gateway = {
    async dispatchRpc() { throw Object.assign(new Error('boom'), { code: 'gateway/invocation-unavailable' }) },
  }
  const mounted = mountWorld({ real, label: 'omp', gateway })
  const res = await callMounted(mounted, real, JSON.stringify({ type: 'client-request', rpcId: 'r3', method: 'session.list', payload: {} }))
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.rpcId, 'r3')
  assert.equal(body.result.error.code, 'gateway/invocation-unavailable')
  mounted.dispose()
})

test('the browser-trust fence runs before any dispatch', async () => {
  const real = fakeReal()
  const gateway = worldGateway()
  const mounted = mountWorld({ real, label: 'omp', gateway, requestRejection: () => 401 })
  const res = await callMounted(mounted, real, JSON.stringify({ type: 'client-request', rpcId: 'r4', method: 'session.list', payload: {} }))
  assert.equal(res.status, 401)
  assert.equal(gateway.calls.length, 0)
  mounted.dispose()
})

test('dispose unregisters the translated unary route', () => {
  const real = fakeReal()
  const mounted = mountWorld({ real, label: 'omp', gateway: worldGateway() })
  assert.equal(real.routes.has('prefix:/omp/api'), true)
  mounted.dispose()
  assert.equal(real.routes.size, 0)
})

test('mountWorld registers the world mux upgrade path and disposes it', () => {
  const real = fakeReal()
  const mounted = mountWorld({ real, label: 'omp', gateway: worldGateway() })
  assert.equal(real.upgrades.has('/omp/api/remote.mux'), true)
  mounted.dispose()
  assert.equal(real.upgrades.size, 0)
})

test('the mux upgrade path is fenced before any socket handover', async () => {
  const real = fakeReal()
  const mounted = mountWorld({ real, label: 'omp', gateway: worldGateway(), requestRejection: () => 401 })
  const handler = real.upgrades.get('/omp/api/remote.mux').handler
  const writes = []
  let destroyed = false
  await handler(
    { url: '/omp/api/remote.mux', headers: {} },
    { write: (chunk) => writes.push(String(chunk)), destroy: () => { destroyed = true } },
    Buffer.alloc(0),
  )
  assert.equal(destroyed, true)
  assert.match(writes.join(''), /^HTTP\/1\.1 401 Unauthorized/)
})

// ---- Carrier fetch passthrough (2026-09-17 H1): non-envelope GET/HEAD on
// `/<label>/api` forwards into the owning world's registered exact Fetch
// routes through the world connection's shared `/api` handler, published via
// the cross-root world-host registry (world-entry does this in production).
import { publishWorldFetch } from '../dist/world-host.js'

function worldFetchHandler(responder) {
  const calls = []
  return {
    calls,
    requestBodyMode: () => 'buffered',
    async fetch(request) {
      calls.push({ url: String(request.url), method: request.method })
      return responder !== undefined ? responder(request) : new Response('not found', { status: 404 })
    },
  }
}

function getReq(url, method = 'GET', headers = {}) {
  return { url, method, headers }
}

async function callRoute(mounted, real, req) {
  const handler = real.routes.get(`prefix:${mounted.apiPath}`).handler
  const res = fakeRes()
  await handler(req, res)
  return res
}

test('non-envelope GET forwards into the world route with the label stripped and query kept', async () => {
  const real = fakeReal()
  const gateway = worldGateway()
  const handler = worldFetchHandler(() => new Response('zip-bytes', {
    status: 200,
    headers: { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="dsh-session-s1.zip"' },
  }))
  const drop = publishWorldFetch('omp', handler)
  const mounted = mountWorld({ real, label: 'omp', gateway })
  const res = await callRoute(mounted, real, getReq('/omp/api/session.export?sessionId=s1&includeDescendants=true'))
  assert.deepEqual(handler.calls, [{ url: 'http://dsh.internal/api/session.export?sessionId=s1&includeDescendants=true', method: 'GET' }])
  assert.equal(res.status, 200)
  assert.deepEqual(res.headers, { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="dsh-session-s1.zip"' })
  assert.equal(Buffer.concat(res.chunks).toString('utf8'), 'zip-bytes')

  assert.equal(gateway.calls.length, 0, 'no RPC dispatch for non-envelope traffic')
  drop()
  mounted.dispose()
})

test('non-envelope HEAD forwards and ends without a body (ZIP probe shape)', async () => {
  const real = fakeReal()
  const handler = worldFetchHandler(() => new Response(null, {
    status: 200,
    headers: { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="dsh-session-s1.zip"' },
  }))
  const drop = publishWorldFetch('omp', handler)
  const mounted = mountWorld({ real, label: 'omp', gateway: worldGateway() })
  const res = await callRoute(mounted, real, getReq('/omp/api/session.export?sessionId=s1&includeDescendants=true', 'HEAD'))
  assert.deepEqual(handler.calls, [{ url: 'http://dsh.internal/api/session.export?sessionId=s1&includeDescendants=true', method: 'HEAD' }])
  assert.equal(res.status, 200)
  assert.equal(res.body, undefined, 'HEAD answer carries no body')
  assert.equal(res.headers['content-disposition'], 'attachment; filename="dsh-session-s1.zip"')
  drop()
  mounted.dispose()
})

test('envelope RPC dispatch is unchanged while the passthrough is mounted', async () => {
  const real = fakeReal()
  const gateway = worldGateway()
  const handler = worldFetchHandler()
  const drop = publishWorldFetch('omp', handler)
  const mounted = mountWorld({ real, label: 'omp', gateway })
  const res = await callRoute(mounted, real, reqWith(JSON.stringify({ type: 'client-request', rpcId: 'r9', method: 'session.list', payload: {} })))
  assert.equal(res.status, 200)
  assert.deepEqual(JSON.parse(res.body), { type: 'server-response', rpcId: 'r9', result: { ok: true, value: 'v' } })
  assert.deepEqual(gateway.calls, [{ endpoint: 'session.list', payload: {}, aborted: false }])
  assert.equal(handler.calls.length, 0, 'the world fetch handler is never consulted for envelopes')
  drop()
  mounted.dispose()
})

test('non-envelope POST still answers the transport-level 400', async () => {
  const real = fakeReal()
  const gateway = worldGateway()
  const handler = worldFetchHandler()
  const drop = publishWorldFetch('omp', handler)
  const mounted = mountWorld({ real, label: 'omp', gateway })
  const res = await callRoute(mounted, real, reqWith('not json'))
  assert.equal(res.status, 400)
  assert.equal(JSON.parse(res.body).result.error.code, 'gateway/bad-request')
  assert.equal(handler.calls.length, 0)
  assert.equal(gateway.calls.length, 0)
  drop()
  mounted.dispose()
})

test('the passthrough runs behind the same ctx0 browser-trust fence', async () => {
  const real = fakeReal()
  const handler = worldFetchHandler()
  const drop = publishWorldFetch('omp', handler)
  const mounted = mountWorld({ real, label: 'omp', gateway: worldGateway(), requestRejection: () => 401 })
  const res = await callRoute(mounted, real, getReq('/omp/api/session.export?sessionId=s1'))
  assert.equal(res.status, 401)
  assert.deepEqual(JSON.parse(res.body), { error: 'unauthorized' })
  assert.equal(handler.calls.length, 0, 'an unauthenticated request never reaches the world')
  drop()
  mounted.dispose()
})

test('unknown world routes answer 404 from the world handler', async () => {
  const real = fakeReal()
  const handler = worldFetchHandler() // default responder: 404 not found
  const drop = publishWorldFetch('omp', handler)
  const mounted = mountWorld({ real, label: 'omp', gateway: worldGateway() })
  const res = await callRoute(mounted, real, getReq('/omp/api/nope?x=1'))
  assert.equal(res.status, 404)
  assert.equal(Buffer.concat(res.chunks).toString('utf8'), 'not found', 'the world handler 404 body streams through')

  drop()
  mounted.dispose()
})

test('a world without a published fetch handler answers 404 (no route can answer)', async () => {
  const real = fakeReal()
  const mounted = mountWorld({ real, label: 'codex', gateway: worldGateway() })
  const res = await callRoute(mounted, real, getReq('/codex/api/session.export?sessionId=s1'))
  assert.equal(res.status, 404)
  mounted.dispose()
})

test('a world fetch handler fault answers 500 without leaking an envelope', async () => {
  const real = fakeReal()
  const handler = worldFetchHandler(() => { throw new Error('world route exploded') })
  const drop = publishWorldFetch('omp', handler)
  const mounted = mountWorld({ real, label: 'omp', gateway: worldGateway() })
  const res = await callRoute(mounted, real, getReq('/omp/api/session.export?sessionId=s1'))
  assert.equal(res.status, 500)
  assert.match(String(res.body), /carrier fetch bridge failure/)
  drop()
  mounted.dispose()

})
