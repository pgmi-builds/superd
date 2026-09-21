// Task 6: activation = roster membership + zero-port world spawn + gateway
// target registration (S2 gate). Mirrors agent-omp/test/world-plugin.test.mjs
// (adapter-side world smoke) with the hub-side anchor default from
// agent-hub/test/world-mount.test.mjs: the shared `.tests`
// `@deepseek-ai` farm is healed to the REPO BUILD, so the smoke must anchor
// there too — booting the world with the plugin's global-install default
// would flip the farm between installations (one DSH_HOME, one installation).
//
// The provider is a Task-7 placeholder: this smoke spawns NO hermes gateway —
// it proves only world boot (zero-port sibling ctx), roster, `/hermes` mount,
// and setReady.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const REPO = join(new URL('../../../..', import.meta.url).pathname)
const HOME = process.env.DSH_HOME ?? join(REPO, '.tests')
// Red line: never boot a world against the prod home.
if (HOME === join(homedir(), '.dsh') || HOME === join(homedir(), '.superd')) {
  throw new Error(`world-plugin smoke refuses prod DSH_HOME: ${HOME}`)
}
process.env.DSH_HOME = HOME
const HERMES_WORLD = join(HOME, 'agents', 'hermes')

// Repo-build anchor (same default as agent-hub/test/world-mount.test.mjs);
// the world-plugin honors SUPERD_DSH_ANCHOR at module scope, so set it before
// importing dist/world-plugin.js.
const ANCHOR = process.env.SUPERD_DSH_ANCHOR
  ?? join(REPO, 'upstream/deepseek-harness/apps/cli/package.json')
process.env.SUPERD_DSH_ANCHOR = ANCHOR

// provision @pgmi-builds scope beside heal's @deepseek-ai in the profile tree:
// the world's loader resolves the hub rows (`@pgmi-builds/agent-hub` and its
// `/world` entry, inserted by worldMountPatches) through AW_BARE_BASE.
const pm = join(HOME, 'profiles', 'node_modules', '@pgmi-builds')
mkdirSync(pm, { recursive: true })
for (const [name, target] of Object.entries({
  'agent-hub': join(REPO, 'super-dsh/agent-hub'),
  'agent-adapter-hermes': join(REPO, 'super-dsh/agent-hermes'),
})) {
  const dst = join(pm, name)
  if (!existsSync(dst)) symlinkSync(target, dst)
}
process.env.AW_BARE_BASE = join(HOME, 'profiles', 'node_modules') + '/'

// ctx0's real webServer, structural: the carrier registers translated routes
// on it (same fake shape as agent-hub/test/world-mount.test.mjs).
function fakeReal() {
  return {
    routes: new Map(),
    upgrades: new Map(),
    fallback: undefined,
    register(route) {
      const id = `${route.kind}:${route.path}`
      this.routes.set(id, route)
      return () => this.routes.delete(id)
    },
    registerUpgrade(route) { this.upgrades.set(route.path, route); return () => this.upgrades.delete(route.path) },
    registerFallback(handler) { this.fallback = handler; return () => { this.fallback = undefined } },
    tapIndex() { return () => { } },
    port: 4998,
    host: '127.0.0.1',
  }
}

test('aw.agent-adapter-hermes: activation = roster + zero-port world spawn + /hermes mount', { skip: !existsSync(ANCHOR) && `dsh install anchor not found: ${ANCHOR}` }, async () => {
  const { name, apply } = await import('../dist/world-plugin.js')
  assert.equal(name, 'aw.agent-adapter-hermes')
  const routing = await import('@pgmi-builds/agent-hub')
  const provided = {}
  const real = fakeReal()
  const connection = {
    authorizeIndex: () => true,
    requestRejection: () => undefined,
  }
  apply({
    provide: (k, v) => { provided[k] = v },
    // the world's boot waits on ctx0's listening stack — hand it the fakes
    inject: (deps, cb) => cb({ webServer: real, connection }),
  })
  // readiness flips only when the world's gateway is live — await it first
  const ctxW = await provided['aw.world.hermes']
  try {
    assert.deepEqual(routing.listAgents(), [{ key: 'hermes', label: 'Hermes', ready: true }])
    assert.ok(existsSync(join(HERMES_WORLD, 'profiles')), 'world DSH home created')
    assert.notEqual(ctxW.get('typertGateway'), undefined, 'world gateway live')
    assert.notEqual(ctxW.get('sessionController'), undefined, 'world RPC face live')
    assert.notEqual(routing.getTarget('hermes')?.gateway, undefined, 'target registered')
    assert.ok(routing.listHostMounts().includes('hermes'), '/hermes host mount registered')
    assert.ok(real.routes.has('prefix:/hermes/api'), 'carrier owns /hermes/api')
    assert.ok(real.upgrades.has('/hermes/api/remote.mux'), 'carrier owns /hermes mux upgrade')
    assert.notEqual(routing.worldServerOf('hermes'), undefined, 'world provided its virtual webServer')
  } finally {
    await ctxW.fiber.dispose()
    // spawned server/child handles must not hold the test runner open
    setTimeout(() => process.exit(0), 250).unref()
  }
})
