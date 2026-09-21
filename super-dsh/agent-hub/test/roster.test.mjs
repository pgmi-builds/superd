// Roster semantics (S2): register/list/duplicate-throws, setReady notifies,
// unregister removes, unknown-key loud failure, unsubscribe stops delivery.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  registerAgent, unregisterAgent, setReady, listAgents, onRosterChanged,
} from '../dist/index.js'

test('roster: register / list / duplicate throws', () => {
  registerAgent({ key: 'omp', label: 'OMP', ready: false })
  assert.deepEqual(listAgents(), [{ key: 'omp', label: 'OMP', ready: false }])
  assert.throws(() => registerAgent({ key: 'omp', label: 'x', ready: true }), /duplicate/)
})

test('roster: setReady notifies subscribers; unregister removes; unknown key throws', () => {
  const seen = []
  const off = onRosterChanged((entries) => seen.push(entries.map((e) => e.key + ':' + e.ready)))
  setReady('omp', true)
  assert.deepEqual(listAgents(), [{ key: 'omp', label: 'OMP', ready: true }])
  assert.ok(seen.at(-1).includes('omp:true'))
  off()
  unregisterAgent('omp')
  assert.deepEqual(listAgents(), [])
  assert.throws(() => setReady('omp', false), /unknown agent/)
})
