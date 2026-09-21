// plugin-acc boot — acceptance boot for the PACKAGED super-dsh line.
// Difference from smoke.mjs: nothing is hand-composed. The profile declares
// bundles [dsh-base, dsh-web-app, super-dsh]; the installed super-dsh package
// carries the whole composite patch (hub + world rows + claude join +
// directory-picker browse pair). Worlds self-provision via the hub's
// provisionWorldProfile (no bootstrap step).
// SUPERD_KEEP: process stays up for first-person acceptance.
import { loadProfile, boot, healProfilesModuleFallback } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { writeFileSync, mkdirSync, symlinkSync, lstatSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const REPO = '/home/u1/workspaces/superd'
const HOME = join(REPO, '.tests', 'plugin-acc')
// Installation-anchor topology (consumer parity): the anchor is the RUNNING
// dsh app's package.json — the repo build's apps/cli — so bundles resolve
// from the installation's own node_modules (apps/cli/node_modules), the same
// way a registry install resolves on a consumer machine. The pnpm workspace
// hoists only direct deps into apps/cli/node_modules, so the loader's bare
// names need the shared fallback farm — exactly what the dsh CLI itself
// builds on every launch via healProfilesModuleFallback (BFS closure of the
// anchor manifest into `$DSH_HOME/profiles/node_modules`).
const ANCHOR = process.env.SUPERD_DSH_ANCHOR ?? join(REPO, 'upstream/deepseek-harness/apps/cli/package.json')
const BARE = process.env.SUPERD_BARE_BASE ?? 'file://' + join(HOME, 'profiles/node_modules') + '/'
const PORT = process.env.ACC_PORT ?? '4996'

// Shared fallback farm (CLI parity) + @pgmi-builds links to the npm-installed
// physical copies, so the world trees' loader rows (`@pgmi-builds/agent-hub`
// mount rows) resolve to the SAME modules ctx0 loaded — one instance everywhere.
await healProfilesModuleFallback({ installAnchor: ANCHOR })
const farmPgmb = join(HOME, 'profiles/node_modules/@pgmi-builds')
mkdirSync(farmPgmb, { recursive: true })
for (const name of ['agent-hub', 'agent-adapter-omp', 'agent-adapter-codex', 'agent-adapter-claude', 'agent-adapter-pi', 'agent-adapter-hermes', 'agent-adapter-agy']) {
  const dst = join(farmPgmb, name)
  const src = join(HOME, 'profiles/acc-web/node_modules/@pgmi-builds', name)
  if (!existsSync(src)) throw new Error(`plugin-acc: installed package missing: ${src}`)
  const st = lstatSync(dst, { throwIfNoEntry: false })
  if (st) rmSync(dst, { recursive: true, force: true })
  symlinkSync(src, dst)
}

const profile = loadProfile('plugin-acc', 'acc-web', ANCHOR, HOME)
writeFileSync(join(profile.dir, 'cordis.yml'), '[]\n')
const patches = [...profile.layers.flatMap((l) => l.patches), ...profile.patches]
let fiber
const ctx = await boot('plugin-acc', join(profile.dir, 'cordis.yml'), patches, (ctx) => {
  provideCmdline(ctx, {
    args: ['--no-open', '--trusted-host', '192.168.31.130', '--trusted-host', `192.168.31.130:${PORT}`],
    exit: () => { void fiber?.dispose() },
  })
}, BARE)
fiber = ctx.fiber
console.log('[plugin-acc] ctx0 booted; worlds self-provisioning; SUPERD_KEEP=1')
setInterval(() => {}, 60_000)
