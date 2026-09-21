// World mount integration (AW-B Task 9): the world root runs with NO listener
// (`webserver` disabled), provides the virtual `webServer` from our world
// entry, and every route its plugins register lands translated on ctx0's real
// webServer — while the RPC channel (/api*) stays with the hub.
import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnWorld, registerHostMount, worldServerOf, worldMountPatches } from '../dist/index.js'
import { WorldWebServer } from '../dist/world-web-server.js'

const REPO = join(new URL('../../..', import.meta.url).pathname)
const HOME = process.env.AW_TEST_HOME ?? join(REPO, '.tests', 'aw')
const FIXTURE = new URL('./fixtures/aw-omp-world/', import.meta.url).pathname
const ANCHOR = process.env.SUPERD_DSH_ANCHOR ?? join(REPO, 'upstream/deepseek-harness/apps/cli/package.json')
const BARE = join(HOME, 'profiles', 'node_modules') + '/'
const PROFILE = 'aw-omp-world-mounted'

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
    port: 4999,
    host: '127.0.0.1',
  }
}

async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  for (; ;) {
    if (check()) return true
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

test('a world with no listener mounts its whole surface under /<label> on ctx0', async () => {
  mkdirSync(join(HOME, 'profiles'), { recursive: true })
  cpSync(FIXTURE, join(HOME, 'profiles', PROFILE), { recursive: true })
  const real = fakeReal()
  const dropMount = registerHostMount({ key: 'omp', labelPath: '/omp', real })

  const ctxW = await spawnWorld({
    appName: PROFILE,
    profileName: PROFILE,
    installAnchor: ANCHOR,
    home: HOME,
    bareModuleBaseUrl: BARE,
    extraPatches: worldMountPatches('omp'),
  })

  const webServer = worldServerOf('omp')
  assert.equal(webServer instanceof WorldWebServer, true, 'the world root got the virtual webServer')
  assert.equal(webServer.labelPath, '/omp')

  const mounted = await waitFor(() => real.routes.has('prefix:/omp/plugins') && real.routes.has('prefix:/omp'))
  assert.equal(mounted, true, `world surface landed under /omp (saw: ${[...real.routes.keys()].join(', ')})`)
  assert.equal(real.routes.has('prefix:/omp/api'), false, 'the world never owns the RPC channel')
  assert.equal(real.upgrades.has('/omp/api/remote.mux'), false, 'the world never owns the mux path')

  await new Promise((resolve) => setTimeout(resolve, 200))
  await ctxW.fiber.dispose()
  dropMount()
})
