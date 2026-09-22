// spawnWorld (Task 3): real dsh-base sibling root from a profile — distinct
// roots, full service face, no web surface (dsh-base has none).
import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnWorld } from '../dist/index.js'
import { boot } from '@deepseek-ai/dsh-app-boot'

// Repo-line contract: the anchor is the checkout build (consumers derive it ambiently).
process.env.SUPERD_DSH_ANCHOR ??= new URL('../../../upstream/deepseek-harness/apps/cli/package.json', import.meta.url).pathname
const { resolveInstallAnchor } = await import('../dist/index.js')
const ANCHOR = resolveInstallAnchor()
const REPO = join(new URL('../../..', import.meta.url).pathname) // super-dsh/agent-hub/test → repo root
// Isolated home (never the live 4999 line's .tests/aw — this test used to
// bootstrap profiles straight into the running line's home).
const HOME = process.env.AW_TEST_HOME ?? join(REPO, '.tests', 'hub-test-home')
const SRC_PROFILE = join(REPO, '.tests', 'profiles', 'ctx1-min')

// bootstrap: ctx1-min profile into the isolated home; strip the fixture's
// stale node_modules (self-referential farm links) and heal a fresh fallback
// farm from the anchor — the same resolution shape every real boot uses.
if (!existsSync(SRC_PROFILE)) throw new Error(`source profile missing: ${SRC_PROFILE}`)
mkdirSync(join(HOME, 'profiles'), { recursive: true })
cpSync(SRC_PROFILE, join(HOME, 'profiles', 'ctx1-min'), { recursive: true, verbatimSymlinks: true })
const { rmSync } = await import('node:fs')
rmSync(join(HOME, 'profiles', 'ctx1-min', 'node_modules'), { recursive: true, force: true })
const { healProfilesModuleFallback } = await import('@deepseek-ai/dsh-app-boot')
await healProfilesModuleFallback({ installAnchor: ANCHOR, home: HOME })
// minimal cordis.yml for ctx0
const { writeFileSync } = await import('node:fs')
mkdirSync(join(HOME, 'profiles', 'ctx0-min'), { recursive: true })
writeFileSync(join(HOME, 'profiles', 'ctx0-min', 'cordis.yml'), '[]\n')

test('spawnWorld: dsh-base sibling root, full service face, no web surface', async () => {
  const ctx0 = await boot('aw-test-ctx0', join(HOME, 'profiles', 'ctx0-min', 'cordis.yml'), [])
  const ctxW = await spawnWorld({
    appName: 'aw-test-world',
    profileName: 'ctx1-min',
    installAnchor: ANCHOR,
    home: HOME,
    bareModuleBaseUrl: join(HOME, 'profiles', 'node_modules') + '/',
  })
  assert.notEqual(ctx0, ctxW)
  for (const name of ['llm', 'sessions', 'agents', 'sessionQuery', 'typert']) {
    assert.notEqual(ctxW.get(name), undefined, `${name} present`)
  }
  for (const name of ['webServer', 'sessionController', 'frontendStatic']) {
    assert.equal(ctxW.get(name), undefined, `${name} absent (dsh-base has none)`)
  }
  await ctxW.fiber.dispose()
  await ctx0.fiber.dispose()
})
