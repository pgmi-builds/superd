// plugin-acc boot — acceptance boot for the PACKAGED super-dsh line.
// Single-pack topology: the profile declares bundles [dsh-base, dsh-web-app,
// super-dsh]; the installed super-dsh package carries the whole composite
// patch (self-referencing subpath rows) and embeds hub + all adapters. Worlds
// self-provision via the hub's provisionWorldProfile (no bootstrap step).
// SUPERD_KEEP: process stays up for first-person acceptance.
import { loadProfile, boot, healProfilesModuleFallback } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = '/home/u1/workspaces/superd'
const HOME = join(REPO, '.tests', 'plugin-acc2')
// Installation-anchor topology (consumer parity): the anchor is the RUNNING
// dsh app's package.json — the repo build's apps/cli — so bundles resolve
// from the installation's own node_modules, the same way a registry install
// resolves on a consumer machine. The pnpm workspace hoists only direct deps
// into apps/cli/node_modules, so the loader's bare names need the shared
// fallback farm — what the dsh CLI itself builds on every launch via
// healProfilesModuleFallback (BFS closure of the anchor manifest into
// `$DSH_HOME/profiles/node_modules`).
const ANCHOR = process.env.SUPERD_DSH_ANCHOR ?? join(REPO, 'upstream/deepseek-harness/apps/cli/package.json')
const PORT = process.env.ACC_PORT ?? '4996'

// Shared fallback farm (CLI parity). The composite rows resolve `super-dsh/*`
// subpaths from the profile's own node_modules; @deepseek-ai/* from this farm.
await healProfilesModuleFallback({ installAnchor: ANCHOR })

const profile = loadProfile('plugin-acc', 'acc-web', ANCHOR, HOME)
writeFileSync(join(profile.dir, 'cordis.yml'), '[]\n')
const patches = [...profile.layers.flatMap((l) => l.patches), ...profile.patches]
let fiber
// NO bareModuleBaseUrl — the real dsh app passes none, so bare row names
// resolve through the ambient chain beside the config file (profile
// node_modules first, shared fallback farm next). Passing an embedder base
// here would break exactly that consumer behavior.
const ctx = await boot('plugin-acc', join(profile.dir, 'cordis.yml'), patches, (ctx) => {
  provideCmdline(ctx, {
    args: ['--no-open', '--trusted-host', '192.168.31.130', '--trusted-host', `192.168.31.130:${PORT}`],
    exit: () => { void fiber?.dispose() },
  })
})
fiber = ctx.fiber
console.log('[plugin-acc] ctx0 booted; worlds self-provisioning; SUPERD_KEEP=1')
setInterval(() => {}, 60_000)
