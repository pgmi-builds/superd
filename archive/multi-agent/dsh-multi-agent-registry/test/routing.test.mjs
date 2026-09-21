import test from 'node:test'
import assert from 'node:assert/strict'
import {
  clearKey,
  readKey,
  resetKeys,
  writeKey,
} from '../dist/routing.js'

// v2: keys are in-memory only — no file, no path override, no harness-home
// touch. These tests pin the memory semantics and (implicitly) that the
// module performs no filesystem I/O.

test('empty store reads undefined', () => {
  resetKeys()
  assert.equal(readKey('s1'), undefined)
})

test('write/read/overwrite/clear lifecycle', () => {
  resetKeys()
  assert.equal(readKey('s1'), undefined) // empty store
  writeKey('s1', 'echo')
  assert.equal(readKey('s1'), 'echo')
  writeKey('s2', 'omp')
  // isolation between sessions
  assert.equal(readKey('s1'), 'echo')
  assert.equal(readKey('s2'), 'omp')
  // overwrite
  writeKey('s1', 'native')
  assert.equal(readKey('s1'), 'native')
  // clear removes exactly one key
  clearKey('s1')
  assert.equal(readKey('s1'), undefined)
  assert.equal(readKey('s2'), 'omp')
})

test('resetKeys drops every key', () => {
  writeKey('a', 'echo')
  writeKey('b', 'omp')
  resetKeys()
  assert.equal(readKey('a'), undefined)
  assert.equal(readKey('b'), undefined)
})
