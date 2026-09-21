// boot() provide/prepare ordering probe — pins the fact AW-C1 needs to pick
// the dshHomePath override mechanism (spec §三/§十一.2). Not an AW-A feature:
// the test asserts the probe ran and prints the report for the record.
import test from 'node:test'
import assert from 'node:assert/strict'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('probe: is dshHomePath already provided when prepare runs?', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-probe-'))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const report = {}
  const ctx = await boot('aw-probe', join(dir, 'cordis.yml'), [], (c) => {
    report.alreadyProvided = c.get('dshHomePath') !== undefined
    try {
      c.provide('dshHomePath', () => '/aw-override')
      report.reprovide = 'ok'
    } catch (e) {
      report.reprovide = 'threw: ' + e.message
    }
  })
  console.log('BOOT-PREPARE-ORDERING:', JSON.stringify(report))
  await ctx.fiber.dispose()
  assert.notEqual(report.alreadyProvided, undefined)
})
