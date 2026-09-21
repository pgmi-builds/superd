// Label table (AW-B DL2/DL4): a world owns exactly one mount path; claiming
// is atomic against the real webServer's duplicate-throw; a collision must be
// loud, with an optional re-home to an alternate root.
import test from 'node:test'
import assert from 'node:assert/strict'
import { claimLabel, labelOf, releaseLabel, listLabels } from '../dist/labels.js'

function fakeReal(taken = []) {
  const set = new Set(taken)
  return {
    set,
    register(path) {
      if (set.has(path)) throw new Error(`webserver: duplicate prefix route "${path}"`)
      set.add(path)
      return () => set.delete(path)
    },
  }
}

test('claimLabel reserves /<key> and releases it', () => {
  const real = fakeReal()
  const claim = claimLabel('omp', { register: real.register.bind(real) })
  assert.equal(claim.path, '/omp')
  assert.equal(labelOf('omp'), '/omp')
  assert.deepEqual(listLabels(), ['omp'])
  assert.equal(real.set.has('/omp'), true)
  releaseLabel('omp')
  assert.equal(labelOf('omp'), undefined)
  assert.equal(real.set.has('/omp'), false)
})

test('claimLabel re-homes to an alternate root when the clean path is taken', () => {
  const real = fakeReal(['/omp'])
  const claim = claimLabel('omp', { register: real.register.bind(real), alternateRoots: ['/_agents'] })
  assert.equal(claim.path, '/_agents/omp')
  assert.equal(labelOf('omp'), '/_agents/omp')
  releaseLabel('omp')
})

test('claimLabel is loud when every candidate path is taken', () => {
  const real = fakeReal(['/omp', '/_agents/omp'])
  assert.throws(
    () => claimLabel('omp', { register: real.register.bind(real), alternateRoots: ['/_agents'] }),
    /no free mount path for "omp" \(tried "\/omp", "\/_agents\/omp"\)/,
  )
  assert.equal(labelOf('omp'), undefined)
})

test('a second claim for the same key is a bug and throws', () => {
  const real = fakeReal()
  claimLabel('omp', { register: real.register.bind(real) })
  assert.throws(() => claimLabel('omp', { register: real.register.bind(real) }), /already claimed at "\/omp"/)
  releaseLabel('omp')
})

test('label keys are validated (no slash, no empty)', () => {
  const real = fakeReal()
  assert.throws(() => claimLabel('', { register: real.register.bind(real) }), /invalid label key/)
  assert.throws(() => claimLabel('a/b', { register: real.register.bind(real) }), /invalid label key/)
})
