// One-shot probe: boot the aw-ctx0 composition into a THROWAWAY home with the
// webserver row disabled, then report the compaction service face.
import { mkdtempSync, cpSync, mkdirSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadProfile, boot } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'

const REPO = '/home/u1/workspaces/superd'
const AW = join(REPO, '.tests/aw')
const T = mkdtempSync(join(tmpdir(), 'aw-probe-'))
mkdirSync(join(T, 'profiles'), { recursive: true })
cpSync(join(AW, 'profiles/aw-ctx0'), join(T, 'profiles/aw-ctx0'), { recursive: true })
symlinkSync(join(AW, 'profiles/node_modules'), join(T, 'profiles/node_modules'))
// The copied profile bakes the line port; repoint to a free probe port.
const profPatch = join(T, 'profiles/aw-ctx0/cordis.patch.yml')
writeFileSync(profPatch, readFileSync(profPatch, 'utf8').replace('port: 4999', 'port: 4985'))

const ANCHOR = join(REPO, 'upstream/deepseek-harness/package.json')
const BARE = 'file://' + join(AW, 'profiles/node_modules') + '/'
const profile = loadProfile('aw-ctx0', 'aw-ctx0', ANCHOR, T)
const patches = [...profile.layers.flatMap((l) => l.patches), ...profile.patches]
let fiber
const ctx = await boot('aw-probe', join(profile.dir, 'cordis.yml'), patches, (c) => {
  provideCmdline(c, { args: ['--no-open'], exit: () => { void fiber?.dispose() } })
}, BARE)
fiber = ctx.fiber
await new Promise((r) => setTimeout(r, 3000))
const compaction = ctx.get('compaction')
console.log('[probe] compaction service:', compaction === undefined ? 'ABSENT' : 'present')
if (compaction !== undefined) {
  console.log('[probe] engine config keys:', Object.keys(compaction.config ?? {}).join(','))
  console.log('[probe] thresholdRatio:', compaction.config?.thresholdRatio, 'retainTokens:', compaction.config?.retainTokens)
}
console.log('[probe] settings ns present:', ctx.get('settings')?.get?.('compaction-tuning') !== undefined)
await fiber.dispose()
process.exit(0)
