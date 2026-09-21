// spawnWorld (Task 3): real dsh-base sibling root from a profile — distinct
// roots, full service face, no web surface (dsh-base has none).
import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnWorld } from '../dist/index.js'
import { boot } from '@deepseek-ai/dsh-app-boot'

const ANCHOR = process.env.SUPERD_DSH_ANCHOR
  ?? '/home/u1/.local/lib/node_modules/@deepseek-ai/dsh/package.json'
const REPO = join(new URL('../../..', import.meta.url).pathname) // super-dsh/agent-hub/test → repo root
const HOME = process.env.AW_TEST_HOME ?? join(REPO, '.tests', 'aw')
const SRC_PROFILE = join(REPO, '.tests', 'profiles', 'ctx1-min')

// bootstrap: ctx1-min profile into the aw home (idempotent)
if (!existsSync(SRC_PROFILE)) throw new Error(`source profile missing: ${SRC_PROFILE}`)
mkdirSync(join(HOME, 'profiles'), { recursive: true })
cpSync(SRC_PROFILE, join(HOME, 'profiles', 'ctx1-min'), { recursive: true })
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
