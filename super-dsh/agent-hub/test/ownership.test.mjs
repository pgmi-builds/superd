// Session → world ownership (AW-B DL9/DL10): O(1) hits, at most ONE bounded
// refresh per miss (concurrent misses coalesce), and a miss after that refresh
// stays a miss — the caller fails where it asked instead of probing worlds.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createOwnershipIndex } from '../dist/ownership.js'

test('indexed sessions resolve in O(1) without any refresh', async () => {
  let refreshes = 0
  const index = createOwnershipIndex(async () => { refreshes += 1; return [] })
  index.set('s1', 'omp')
  assert.equal(index.lookup('s1'), 'omp')
  assert.equal(await index.resolve('s1'), 'omp')
  assert.equal(refreshes, 0)
})

test('a miss triggers exactly one bounded refresh, even under concurrent misses', async () => {
  let refreshes = 0
  const rows = [{ sessionId: 's2', key: 'codex' }]
  const index = createOwnershipIndex(async () => { refreshes += 1; return rows })
  const [a, b, c] = await Promise.all([index.resolve('s2'), index.resolve('s2'), index.resolve('s2')])
  assert.deepEqual([a, b, c], ['codex', 'codex', 'codex'])
  assert.equal(refreshes, 1)
})

test('an unknown session stays unknown and performs no further probing', async () => {
  let refreshes = 0
  const index = createOwnershipIndex(async () => { refreshes += 1; return [] })
  assert.equal(await index.resolve('nope'), undefined)
  assert.equal(await index.resolve('nope'), undefined)
  assert.equal(refreshes, 2, 'one refresh per resolve call, never a fan-out')
})

test('refresh rows populate the index and overwrite stale owners', async () => {
  const index = createOwnershipIndex(async () => [{ sessionId: 's3', key: 'omp' }])
  assert.equal(await index.resolve('s3'), 'omp')
  index.set('s3', 'native')
  assert.equal(index.lookup('s3'), 'native')
  index.forget('s3')
  assert.equal(index.lookup('s3'), undefined)
  assert.equal(index.size(), 0)
})

test('without a refresh function a miss is simply a miss', async () => {
  const index = createOwnershipIndex()
  assert.equal(await index.resolve('s4'), undefined)
})

test('clear drops the whole roster', () => {
  const index = createOwnershipIndex()
  index.set('a', 'native')
  index.set('b', 'omp')
  assert.equal(index.size(), 2)
  index.clear()
  assert.equal(index.size(), 0)
  assert.equal(index.lookup('a'), undefined)
})
