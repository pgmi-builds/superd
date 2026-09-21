import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AGENT_RUNTIME_RPC_PATH,
  availableRuntimes,
  registerRuntimeKeyRpc,
} from '../dist/rpc.js'
import { readKey, resetKeys, writeKey } from '../dist/routing.js'

function freshStore() {
  resetKeys()
}

// Fake ctx: inject immediately invokes the callback with a scoped ctx carrying
// `connection`; effect runs fn and returns its disposer.
function makeFakeCtx() {
  const registered = []
  const ctx = {
    inject(_deps, cb) {
      const scoped = Object.create(ctx)
      scoped.connection = { fetch: { register: (route) => { registered.push(route); return async () => {} } } }
      cb(scoped)
    },
    effect(fn, _label) {
      const out = fn()
      return typeof out === 'function' ? out : () => {}
    },
  }
  ctx.registered = registered
  return ctx
}

const fakeSource = { listFactories: () => ['native', 'echo'] }

function get() {
  const ctx = makeFakeCtx()
  registerRuntimeKeyRpc(ctx, fakeSource)
  assert.equal(ctx.registered.length, 1)
  const route = ctx.registered[0]
  assert.equal(route.path, AGENT_RUNTIME_RPC_PATH)
  assert.equal(route.path, '/api/agent-runtime')
  assert.deepEqual([...route.methods], ['GET', 'POST'])
  assert.equal(route.requestBody, 'buffered')
  return route
}

test('registers one GET+POST buffered route at /api/agent-runtime', get)

test('GET returns current key with native default and available list', async () => {
  freshStore()
  const route = get()
  const res = await route.fetch(new Request('http://x/api/agent-runtime?sessionId=s1'))
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { sessionId: 's1', runtime: 'native', available: ['native', 'echo'] })
  writeKey('s1', 'echo')
  const res2 = await route.fetch(new Request('http://x/api/agent-runtime?sessionId=s1'))
  assert.deepEqual(await res2.json(), { sessionId: 's1', runtime: 'echo', available: ['native', 'echo'] })
  assert.equal(readKey('s1'), 'echo')
})

test('GET without sessionId is 400', async () => {
  const route = get()
  const res = await route.fetch(new Request('http://x/api/agent-runtime'))
  assert.equal(res.status, 400)
})

test('POST writes a known runtime key', async () => {
  freshStore()
  const route = get()
  const res = await route.fetch(new Request('http://x/api/agent-runtime', {
    method: 'POST',
    body: JSON.stringify({ sessionId: 's9', runtime: 'echo' }),
  }))
  assert.equal(res.status, 200)
  assert.equal(readKey('s9'), 'echo')
})

test('POST with an unknown runtime is 400 and does not write', async () => {
  freshStore()
  const route = get()
  const res = await route.fetch(new Request('http://x/api/agent-runtime', {
    method: 'POST',
    body: JSON.stringify({ sessionId: 's9', runtime: 'nope' }),
  }))
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.ok(String(body.error).includes('unknown runtime'))
  assert.equal(readKey('s9'), undefined)
})

test('POST with malformed body / missing fields is 400', async () => {
  const route = get()
  for (const body of ['not json', '{}', JSON.stringify({ sessionId: 's' }), JSON.stringify({ runtime: 'echo' })]) {
    const res = await route.fetch(new Request('http://x/api/agent-runtime', { method: 'POST', body }))
    assert.equal(res.status, 400, body)
  }
})

test('availableRuntimes always leads with native, dedupes the native key', () => {
  assert.deepEqual(availableRuntimes({ listFactories: () => [] }), ['native'])
  assert.deepEqual(availableRuntimes({ listFactories: () => ['native', 'echo'] }), ['native', 'echo'])
  assert.deepEqual(availableRuntimes({ listFactories: () => ['echo', 'native'] }), ['native', 'echo'])
})

test('registerRuntimeKeyRpc is a no-op when connection.fetch is absent', () => {
  const ctx = {
    inject(_deps, cb) { cb(Object.create(ctx)) },
    effect(fn) { const o = fn(); return typeof o === 'function' ? o : () => {} },
  }
  registerRuntimeKeyRpc(ctx, fakeSource) // must not throw
})
