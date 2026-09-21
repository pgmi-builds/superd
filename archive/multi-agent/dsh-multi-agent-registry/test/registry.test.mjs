import test from 'node:test'
import assert from 'node:assert/strict'
import MultiAgentRegistry from '../dist/index.js'
import { resetKeys, writeKey } from '../dist/routing.js'
import { symbols } from '@deepseek-ai/cordis'

// Per-process in-memory keys (v2: no file). Tests reset the map for isolation.

// ---------------------------------------------------------------------------
// Fake cordis Context: the minimal surface the Service + AgentRegistry
// constructor chain touches, plus what MultiAgentRegistry itself uses.
//
// Service base constructor:  ctx.reflect.provide(name, self, check)
// AgentRegistry constructor: ctx.inject(['typert'], cb), ctx.accessor(...),
//                            ctx.on('internal/status', cb), ctx.effect(genFn)
// MultiAgentRegistry:        ctx.effect(fn, label) (plain fn returning disposer)
//
// We never fire 'internal/status' and never iterate the constructor's
// generator effect, so hasLifecycleAncestor / disposeInitiators never run.
// ---------------------------------------------------------------------------
function makeFakeCtx(withLogger = false) {
  const noop = () => {}
  const warns = []
  const fakeTypert = {
    lookups: { register: noop },
    contexts: { registerHost: noop },
  }
  const ctx = {
    ...(withLogger ? { logger: { warn: (...args) => warns.push(args) } } : {}),
    reflect: { provide: noop },
    // cordis inject returns a scoped context; the registry only reads
    // typeCtx.typert.*, so we hand the callback a ctx-like object carrying it.
    inject(deps, cb) {
      const scoped = Object.create(ctx)
      scoped.typert = fakeTypert
      const inner = cb(scoped)
      return { dispose: noop, ...inner }
    },
    accessor: noop,
    on: () => noop, // disposer
    effect(fn, _label) {
      const out = fn()
      return typeof out === 'function' ? out : noop
    },
  }
  ctx.warns = warns
  return ctx
}

// Isolate the in-memory key map per test.
function isolatedKeyStore() {
  resetKeys()
}


function makeRegistry(withLogger = false) {
  return new MultiAgentRegistry(makeFakeCtx(withLogger))
}

function makeNativeFactory() {
  const calls = []
  const factory = {
    createAgent(ctx, options) {
      calls.push({ method: 'createAgent', ctx, options })
      return { kind: 'agent', options }
    },
    resume(ctx, options) {
      calls.push({ method: 'resume', ctx, options })
      return { kind: 'agent', options }
    },
  }
  factory.calls = calls
  return factory
}

test('constructor succeeds against the minimal fake ctx surface', () => {
  assert.doesNotThrow(() => makeRegistry())
})

test('setFactory twice throws (same-key fail-loud)', () => {
  const reg = makeRegistry()
  const d1 = reg.setFactory(makeNativeFactory())
  assert.equal(typeof d1, 'function')
  assert.throws(
    () => reg.setFactory(makeNativeFactory()),
    /an agent factory is already registered for "native"/,
  )
})

test('appendFactory(key) coexists with setFactory (multi-slot)', () => {
  const reg = makeRegistry()
  const dn = reg.setFactory(makeNativeFactory())
  const df = reg.appendFactory('omp', makeNativeFactory())
  assert.equal(typeof df, 'function')
  // a second foreign factory under the SAME key still fails loud
  assert.throws(
    () => reg.appendFactory('omp', makeNativeFactory()),
    /an agent factory is already registered for "omp"/,
  )
  // distinct foreign keys are fine too
  assert.doesNotThrow(() => reg.appendFactory('pi', makeNativeFactory()))
})

test('disposer invocation removes the key (registration can be re-made)', async () => {
  const reg = makeRegistry()
  const d = reg.setFactory(makeNativeFactory())
  d()
  // after disposal the slot is free again: re-registering must not throw…
  let dMid
  assert.doesNotThrow(() => { dMid = reg.setFactory(makeNativeFactory()) })
  dMid()
  // …and create now works again (fresh factory reachable through native slot)
  const f = makeNativeFactory()
  const d2 = reg.setFactory(f)
  await reg.create({ sessionId: 's1', prompt: 'hi' })
  assert.equal(f.calls.length, 1)
  d2()
})

test('disposer removes exactly its own key (stale disposer is a no-op)', async () => {
  const reg = makeRegistry()
  const f1 = makeNativeFactory()
  const d1 = reg.setFactory(f1)
  d1()
  const f2 = makeNativeFactory()
  reg.setFactory(f2)
  // d1's guarded teardown must NOT delete f2's registration
  d1() // idempotent / no throw
  await reg.create({ sessionId: 's2' })
  assert.equal(f2.calls.length, 1)
})

test('create delegates to the native factory with options passed verbatim', async () => {
  const reg = makeRegistry()
  const f = makeNativeFactory()
  reg.setFactory(f)
  const options = { sessionId: 'sess-42', prompt: 'hello', tools: ['bash'] }
  const handle = await reg.create(options)
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].method, 'createAgent')
  assert.strictEqual(f.calls[0].options, options) // verbatim, same reference
  assert.equal(handle.kind, 'agent')
  assert.strictEqual(handle.options, options)
})

test('resume delegates to the native factory with options passed verbatim', async () => {
  const reg = makeRegistry()
  const f = makeNativeFactory()
  reg.setFactory(f)
  const options = { resumeSessionId: 'sess-42' }
  await reg.resume(options)
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].method, 'resume')
  assert.strictEqual(f.calls[0].options, options)
})

test('create with no factory registered throws', async () => {
  const reg = makeRegistry()
  await assert.rejects(
    () => reg.create({ sessionId: 's' }),
    /no agent factory registered/,
  )
})

test('M0 routing: resolve is always native even when foreign keys are registered', async () => {
  const reg = makeRegistry()
  const native = makeNativeFactory()
  const foreign = makeNativeFactory()
  reg.setFactory(native)
  reg.appendFactory('omp', foreign)
  await reg.create({ sessionId: 'any' })
  await reg.resume({ resumeSessionId: 'any' })
  assert.equal(native.calls.length, 2) // create + resume both hit native
  assert.equal(foreign.calls.length, 0) // foreign slot never consulted in M0
})

test('append unwraps factory[symbols.original] to the traced target', async () => {
  isolatedKeyStore()
  const reg = makeRegistry()
  const target = makeNativeFactory()
  // A Service read through a context carries [symbols.original]; the registry
  // must store the unwrapped target (upstream setFactory pattern).
  const wrapped = Object.assign(makeNativeFactory(), { [symbols.original]: target })
  const native = makeNativeFactory()
  reg.setFactory(native)
  reg.appendFactory('echo', wrapped)
  writeKey('s1', 'echo')
  await reg.create({ sessionId: 's1' })
  assert.equal(target.calls.length, 1) // delegation hit the UNWRAPPED target
  assert.equal(wrapped.calls.length, 0) // …never the shadow wrapper
  assert.strictEqual(target.calls[0].options.sessionId, 's1')
})

test('key routing: keyed session delegates to the keyed factory', async () => {
  isolatedKeyStore()
  const reg = makeRegistry()
  const native = makeNativeFactory()
  const echo = makeNativeFactory()
  reg.setFactory(native)
  reg.appendFactory('echo', echo)
  writeKey('s-echo', 'echo')
  await reg.create({ sessionId: 's-echo' })
  await reg.resume({ resumeSessionId: 's-echo' })
  assert.equal(echo.calls.length, 2)
  assert.equal(native.calls.length, 0)
})

test('key routing: stale key falls back to native with a single warn (no throw)', async () => {
  isolatedKeyStore()
  const reg = makeRegistry(true)
  const native = makeNativeFactory()
  reg.setFactory(native)
  writeKey('s-gone', 'unregistered-runtime')
  await reg.create({ sessionId: 's-gone' })
  await reg.create({ sessionId: 's-gone' })
  assert.equal(native.calls.length, 2) // delivery survived the stale key
  const warns = reg.ctx.warns.filter((args) => String(args[0]).includes('unregistered-runtime'))
  assert.equal(warns.length, 1) // exactly one warn per stale key
})

test('key routing: no key resolves to native (default)', async () => {
  isolatedKeyStore()
  const reg = makeRegistry()
  const native = makeNativeFactory()
  const echo = makeNativeFactory()
  reg.setFactory(native)
  reg.appendFactory('echo', echo)
  await reg.create({ sessionId: 's-plain' })
  assert.equal(native.calls.length, 1)
  assert.equal(echo.calls.length, 0)
  assert.equal(reg.ctx.warns.length, 0) // no logger wired, no crash either
})

test('pipe guard: options reference identity reaches the keyed factory unchanged', async () => {
  isolatedKeyStore()
  const reg = makeRegistry()
  const echo = makeNativeFactory()
  reg.setFactory(makeNativeFactory())
  reg.appendFactory('echo', echo)
  writeKey('s-id', 'echo')
  const createOptions = { sessionId: 's-id', prompt: 'hello', tools: ['bash'] }
  await reg.create(createOptions)
  const resumeOptions = { resumeSessionId: 's-id' }
  await reg.resume(resumeOptions)
  assert.strictEqual(echo.calls[0].options, createOptions)
  assert.strictEqual(echo.calls[1].options, resumeOptions)
})

test('ownsSession probe: no in-memory key → foreign owner claims and the claim is cached', async () => {
  isolatedKeyStore()
  const reg = makeRegistry()
  const native = makeNativeFactory()
  const omp = makeNativeFactory()
  let probes = 0
  const ompFactory = Object.assign(omp, {
    ownsSession(sessionId) {
      probes += 1
      return sessionId === 's-owned'
    },
  })
  reg.setFactory(native)
  reg.appendFactory('omp', ompFactory)
  // fresh-process shape: no key anywhere, owner index says omp
  await reg.resume({ resumeSessionId: 's-owned' })
  assert.equal(omp.calls.length, 1)
  assert.equal(native.calls.length, 0)
  assert.equal(probes, 1) // second delivery uses the cached key, no re-probe
  await reg.resume({ resumeSessionId: 's-owned' })
  assert.equal(omp.calls.length, 2)
  assert.equal(probes, 1)
  // a session the owner declines routes native
  await reg.resume({ resumeSessionId: 's-other' })
  assert.equal(native.calls.length, 1)
})

test('ownsSession probe: a throwing probe degrades to native (no delivery death)', async () => {
  isolatedKeyStore()
  const reg = makeRegistry(true)
  const native = makeNativeFactory()
  const omp = makeNativeFactory()
  const ompFactory = Object.assign(omp, {
    ownsSession() {
      throw new Error('index unavailable')
    },
  })
  reg.setFactory(native)
  reg.appendFactory('omp', ompFactory)
  await reg.create({ sessionId: 's-throw' })
  assert.equal(native.calls.length, 1)
  assert.equal(omp.calls.length, 0)
  assert.ok(reg.ctx.warns.some((args) => String(args[0]).includes('ownsSession probe threw')))
})
