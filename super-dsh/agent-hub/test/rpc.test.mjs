// Control-plane RPC semantics after DL7 (no server-side selection):
// the face answers ONLY `available`; world ownership is per-request and
// travels on the mount path (`/<label>/...`), never through a global switch.
import test from 'node:test'
import assert from 'node:assert/strict'
import { handleAgentRuntime, registerSelectorRpc } from '../dist/rpc.js'

function fakeCtx() {
  const routes = []
  return {
    routes,
    inject(_deps, cb) { cb(this) },
    effect(fn) { fn(); return () => { } },
    connection: {
      fetch: {
        register(route) { routes.push(route); return async () => { } },
      },
    },
  }
}

test('GET exposes the available worlds AND the roster paths the selector navigates', async () => {
  const source = { listRuntimes: () => ['native', 'omp'] }
  const res = await handleAgentRuntime(new Request('http://x/api/agent-runtime'), source)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.deepEqual(body.available, ['native', 'omp'])
  // `agents` is the roster: native always, plus every key that currently owns a
  // host mount (none in this unit test), so the selector has a path per entry.
  assert.deepEqual(body.agents, [{ key: 'native', label: 'DSH', path: '/' }])
})

test('POST carries NO switch: selection is per-request (mount path)', async () => {
  const source = { listRuntimes: () => ['native', 'omp'] }
  const res = await handleAgentRuntime(
    new Request('http://x/api/agent-runtime', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runtime: 'omp' }),
    }),
    source,
  )
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.equal(body.error, 'selection is per-request (mount path); no server-side switch')
  assert.deepEqual(body.available, ['native', 'omp'])
})

test('registerSelectorRpc mounts the control face on the shared /api channel', async () => {
  const ctx = fakeCtx()
  registerSelectorRpc(ctx, { listRuntimes: () => ['native'] })
  assert.equal(ctx.routes.length, 1)
  const res = await ctx.routes[0].fetch(new Request('http://x/api/agent-runtime'))
  const body = await res.json()
  assert.deepEqual(body.available, ['native'])
  assert.deepEqual(body.agents, [{ key: 'native', label: 'DSH', path: '/' }])
})
