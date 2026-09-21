// Task 6: activation = roster membership + zero-touch world spawn + gateway
// target registration. Real dsh tree; requires SUPERD_DSH_ANCHOR.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

const ANCHOR = process.env.SUPERD_DSH_ANCHOR
const HOME = process.env.DSH_HOME ?? '/home/u1/workspaces/superd/.tests/aw'
const OMP_HOME = join(HOME, 'agents', 'omp')

// provision @pgmi-builds scope beside heal's @deepseek-ai in the profile tree
const pm = join(HOME, 'profiles', 'node_modules', '@pgmi-builds')
mkdirSync(pm, { recursive: true })
const dst = join(pm, 'agent-adapter-omp')
if (!existsSync(dst)) symlinkSync('/home/u1/workspaces/superd/super-dsh/agent-omp', dst)
process.env.AW_BARE_BASE = join(HOME, 'profiles', 'node_modules') + '/'
process.env.OMP_HOME = OMP_HOME
mkdirSync(OMP_HOME, { recursive: true })

test('aw.agent-adapter-omp: activation = roster + world spawn + gateway target', { skip: !ANCHOR && 'SUPERD_DSH_ANCHOR not set' }, async () => {
  const { name, apply } = await import('../dist/world-plugin.js')
  assert.equal(name, 'aw.agent-adapter-omp')
  const routing = await import('@pgmi-builds/agent-hub')
  const provided = {}
  apply({ provide: (k, v) => { provided[k] = v } })
  // readiness flips only when the world's gateway is live — await it first
  const ctxW = await provided['aw.world.omp']
  try {
    assert.deepEqual(routing.listAgents(), [{ key: 'omp', label: 'OMP', ready: true }])
    assert.ok(existsSync(OMP_HOME), 'nested home created')
    assert.notEqual(ctxW.get('typertGateway'), undefined, 'world gateway live')
    assert.notEqual(ctxW.get('sessionController'), undefined, 'world RPC face live')
    assert.notEqual(routing.getTarget('omp')?.gateway, undefined, 'target registered')
  } finally {
    await ctxW.fiber.dispose()
    // spawned server/child handles must not hold the test runner open
    setTimeout(() => process.exit(0), 250).unref()
  }
})
