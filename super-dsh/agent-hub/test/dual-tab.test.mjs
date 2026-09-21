// Dual-tab isolation (AW-B DL10): two tabs on two worlds must not step on each
// other, and a wrong sessionId must be answered by exactly the addressed world
// — never by probing the others (no server-side selection anywhere; the mount
// path is the only routing key).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mountWorld } from '../dist/carrier.js'
import { createOwnershipIndex } from '../dist/ownership.js'

function fakeReal() {
  return {
    routes: new Map(),
    upgrades: new Map(),
    register(route) {
      const id = `${route.kind}:${route.path}`
      if (this.routes.has(id)) throw new Error(`webserver: duplicate route ${id}`)
      this.routes.set(id, route)
      return () => this.routes.delete(id)
    },
    registerUpgrade(route) { this.upgrades.set(route.path, route); return () => this.upgrades.delete(route.path) },
    registerFallback() { return () => { } },
    tapIndex() { return () => { } },
    port: 4999,
    host: '127.0.0.1',
  }
}

function world(key, calls) {
  return {
    async dispatchRpc(endpoint, payload) {
      calls.push(`${key}:${endpoint}`)
      if (endpoint === 'session.resume' && payload?.sessionId === 'nope') {
        return { ok: false, error: { code: 'session/not-found', message: 'no such session' } }
      }
      return { ok: true, value: `${key}:${endpoint}` }
    },
    openWireStream() { return (async function*() { })() },
  }
}

function fakeRes() {
  return { status: 0, body: undefined, writeHead(status) { this.status = status }, end(body) { this.body = body } }
}

function request(body, url) {
  return {
    url,
    method: 'POST',
    headers: {},
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) },
  }
}

async function call(real, url, body) {
  const res = fakeRes()
  const handler = real.routes.get(`prefix:${url.split('/').slice(0, 3).join('/')}`).handler
  await handler(request(body, url), res)
  return { status: res.status, body: JSON.parse(res.body) }
}

function envelope(rpcId, method, payload) {
  return { type: 'client-request', rpcId, method, payload }
}

test('two mounted worlds keep separate call ledgers under interleaved traffic', async () => {
  const real = fakeReal()
  const ompCalls = []
  const codexCalls = []
  const omp = mountWorld({ real, label: 'omp', gateway: world('omp', ompCalls) })
  const codex = mountWorld({ real, label: 'codex', gateway: world('codex', codexCalls) })

  await call(real, '/omp/api/session.list', envelope('r1', 'session.list', {}))
  await call(real, '/codex/api/session.list', envelope('r2', 'session.list', {}))
  await call(real, '/omp/api/session.list', envelope('r3', 'session.list', {}))

  assert.deepEqual(ompCalls, ['omp:session.list', 'omp:session.list'])
  assert.deepEqual(codexCalls, ['codex:session.list'])
  omp.dispose()
  codex.dispose()
})

test('a wrong sessionId is answered once by the addressed world and probes nothing else', async () => {
  const real = fakeReal()
  const ompCalls = []
  const codexCalls = []
  const omp = mountWorld({ real, label: 'omp', gateway: world('omp', ompCalls) })
  const codex = mountWorld({ real, label: 'codex', gateway: world('codex', codexCalls) })

  const result = await call(real, '/omp/api/session.resume', envelope('r4', 'session.resume', { sessionId: 'nope' }))
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.result, { ok: false, error: { code: 'session/not-found', message: 'no such session' } })
  assert.deepEqual(ompCalls, ['omp:session.resume'])
  assert.deepEqual(codexCalls, [], 'the other world is never asked')

  const ownership = createOwnershipIndex(async () => [])
  assert.equal(await ownership.resolve('nope'), undefined)
  assert.deepEqual(ompCalls, ['omp:session.resume'], 'an ownership miss dispatches nothing')
  assert.deepEqual(codexCalls, [])
  omp.dispose()
  codex.dispose()
})

test('an ownership hit routes to the owning world without touching the other', async () => {
  const real = fakeReal()
  const ompCalls = []
  const codexCalls = []
  const omp = mountWorld({ real, label: 'omp', gateway: world('omp', ompCalls) })
  const codex = mountWorld({ real, label: 'codex', gateway: world('codex', codexCalls) })
  const ownership = createOwnershipIndex(async () => [{ sessionId: 's1', key: 'codex' }])

  const key = await ownership.resolve('s1')
  assert.equal(key, 'codex')
  assert.deepEqual(ompCalls, [])
  await call(real, `/codex/api/session.list`, envelope('r5', 'session.list', {}))
  assert.deepEqual(ompCalls, [], 'the non-owning world stays untouched')
  assert.deepEqual(codexCalls, ['codex:session.list'])
  omp.dispose()
  codex.dispose()
})

test('disposing one mount leaves the other serving', async () => {
  const real = fakeReal()
  const ompCalls = []
  const codexCalls = []
  const omp = mountWorld({ real, label: 'omp', gateway: world('omp', ompCalls) })
  const codex = mountWorld({ real, label: 'codex', gateway: world('codex', codexCalls) })
  omp.dispose()
  assert.equal(real.routes.has('prefix:/omp/api'), false)
  assert.equal(real.routes.has('prefix:/codex/api'), true)
  await call(real, '/codex/api/session.list', envelope('r6', 'session.list', {}))
  assert.deepEqual(codexCalls, ['codex:session.list'])
  codex.dispose()
})
