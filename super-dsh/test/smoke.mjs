// AW-A smoke (Task 7): CTX0 = web face on the line port + agent-hub gateway
// + the adapter's WORLD PLUGIN (ctx0 does NOT compose the adapter bundle —
// omp rows belong to the world). The plugin spawns ctx-omp itself (S2).
// SUPERD_KEEP: process stays up for first-person acceptance.
import { loadProfile, boot } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { writeFileSync, mkdirSync, existsSync, symlinkSync, rmSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO = '/home/u1/workspaces/superd'
const HOME = process.env.DSH_HOME ?? join(REPO, '.tests', 'aw')
const ANCHOR = process.env.SUPERD_DSH_ANCHOR ?? join(REPO, 'upstream/deepseek-harness/package.json')
const BARE = pathToFileURL(process.env.AW_BARE_BASE ?? join(HOME, 'profiles/node_modules') + '/').href
const PORT = process.env.AW_PORT ?? '4999'

// ---- provision the ctx0 profile + @pgmi-builds links (idempotent) ----
const profDir = join(HOME, 'profiles')
mkdirSync(join(profDir, 'aw-ctx0'), { recursive: true })
writeFileSync(join(profDir, 'aw-ctx0/package.json'), JSON.stringify({
  name: 'aw-ctx0-profile', private: true,
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@pgmi-builds/agent-hub'] } },
  dependencies: {
    '@pgmi-builds/agent-hub': `file:${join(REPO, 'super-dsh/agent-hub')}`,
    // SCOPE (2026-09-16 user ruling): this line composes NO native-runtime
    // capability bundles (compaction etc.) — Native Dash Runtime functionality
    // ships with Dash, not agent-worlds. The compaction-tuning probe package
    // proved the per-world WebUI separation and was removed; see
    // docs/superpowers/plans/2026-09-16-compaction-tuning-native-only-acceptance-report.md.
  } }, null, 2))
writeFileSync(join(profDir, 'aw-ctx0/cordis.patch.yml'), `# ctx0 web face on the line port (loopback; LAN only via socat/Caddy, per repo port discipline)
- id: webserver
  config:
    host: 127.0.0.1
    port: ${PORT}
- insert:
    # AW-B: the adapter's WORLD plugin row (NOT its bundle patch — that patch
    # belongs to the world root and would disable ctx0's native agent loop).
    - id: aw-agent-adapter-omp
      name: '@pgmi-builds/agent-adapter-omp/world'
    - id: aw-agent-adapter-codex
      name: '@pgmi-builds/agent-adapter-codex/world'
    - id: aw-agent-adapter-pi
      name: '@pgmi-builds/agent-adapter-pi/world'
    - id: aw-agent-adapter-hermes
      name: '@pgmi-builds/agent-adapter-hermes/world'
    - id: aw-agent-adapter-agy
      name: '@pgmi-builds/agent-adapter-agy/world'
    # R2 (2026-09-16): the claude adapter ships STANDALONE only — its /world
    # entry is inert. The HUB side joins it: one generic joiner row with the
    # key; spawn/roster/mount wiring lives in @pgmi-builds/agent-hub/join.
    - id: aw-world-join-claude
      name: '@pgmi-builds/agent-hub/join'
      config:
        key: claude
        label: Claude
    - id: directory-picker-browse
      name: '@deepseek-ai/dsh-host-directory-picker-browse'
    - id: directory-picker-browse-surface
      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'
- id: directory-picker
  disabled: true
`)
const pgmb = join(profDir, 'node_modules', '@pgmi-builds')
mkdirSync(pgmb, { recursive: true })
// Package name -> source directory (they differ: agent-omp/ ships
// @pgmi-builds/agent-adapter-omp). Both the line home and every nested world
// home need these links: profile bundles resolve from the profile directory.
const PGMB_PACKAGES = [
  ['agent-hub', 'agent-hub'],
  ['agent-adapter-omp', 'agent-omp'],
  ['agent-adapter-codex', 'agent-codex'],
  ['agent-adapter-pi', 'agent-pi'],
  ['agent-adapter-hermes', 'agent-hermes'],
  // (compaction-tuning was here 2026-09-16 as a native-world-only probe;
  // removed with the package — native-runtime capability ships with Dash, not
  // this line. See docs/superpowers/plans/2026-09-16-compaction-tuning-native-only-acceptance-report.md.)
  ['agent-adapter-claude', 'agent-claude'],
  ['agent-adapter-agy', 'agent-agy'],
]
function linkPgmbPkgs(target) {
  mkdirSync(target, { recursive: true })
  for (const [name, dir] of PGMB_PACKAGES) {
    const dst = join(target, name)
    const src = join(REPO, 'super-dsh', dir)
    // lstat: existsSync is false for DANGLING links (e.g. after a repo move),
    // which skipped rmSync and crashed symlinkSync with EEXIST.
    const st = lstatSync(dst, { throwIfNoEntry: false })
    if (st) rmSync(dst, { recursive: true, force: true })
    symlinkSync(src, dst)
  }
}
linkPgmbPkgs(pgmb)

// ---- provision each WORLD's nested home (layout ruling 2026-09-16) ----
// native: HOME                                  (ctx0 sessions/settings here)
// world:  HOME/agents/<label>                    (that runtime's whole world)
//   └ profiles/web                               (base + web-app + adapter)
//   └ profiles/node_modules/@pgmi-builds/*       (adapter + hub resolvable)
// The world's own DSH data (sessions/settings/workspaces) lands directly in
// that nested home, so no two runtimes share a session list.
for (const [label, adapter, adapterDir] of [
  ['omp', 'agent-adapter-omp', 'agent-omp'],
  ['codex', 'agent-adapter-codex', 'agent-codex'],
  ['claude', 'agent-adapter-claude', 'agent-claude'],
  ['pi', 'agent-adapter-pi', 'agent-pi'],
  ['hermes', 'agent-adapter-hermes', 'agent-hermes'],
  ['agy', 'agent-adapter-agy', 'agent-agy'],
]) {
  const worldHome = join(HOME, 'agents', label)
  const worldProf = join(worldHome, 'profiles', 'web')
  mkdirSync(worldProf, { recursive: true })
  writeFileSync(join(worldProf, 'package.json'), JSON.stringify({
    name: `aw-${label}-world-profile`, private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', `@pgmi-builds/${adapter}`] } },
    dependencies: { [`@pgmi-builds/${adapter}`]: `file:${join(REPO, 'super-dsh', adapterDir)}` },
  }, null, 2))
  // Top-level YAML ARRAY: the profile overlay is a patch list. The world's
  // listener posture is owned by worldMountPatches (webserver off + virtual
  // webServer). What belongs HERE is the per-world home pinning: every DSH
  // plugin that resolves its document from the harness home gets `dshHome`
  // from THIS tree's `dshHomePath` service (which spawnWorld overrides to the
  // nested root), so a world's settings/credentials/attachments/skills stay
  // inside `agents/<label>/` — EVERYTHING is nested. (`agent-instructions`
  // keeps its base config `maxBytes`, so its home is the one exception; it is
  // an instruction-discovery root, not agent data.)
  writeFileSync(join(worldProf, 'cordis.patch.yml'), [
    '# Per-world home pinning (dshHomePath is this tree\'s nested home).',
    ...['settings', 'credentials', 'attachment-local', 'shell-env', 'skill-filesystem']
      .flatMap((id) => [`- id: ${id}`, '  config:', '    dshHome: !!js dshHomePath()']),
    '',
  ].join('\n'))
  linkPgmbPkgs(join(worldHome, 'profiles', 'node_modules', '@pgmi-builds'))
}

// ---- boot ctx0 ----
const profile = loadProfile('aw-ctx0', 'aw-ctx0', ANCHOR, HOME)
writeFileSync(join(profile.dir, 'cordis.yml'), '[]\n')
const patches = [...profile.layers.flatMap((l) => l.patches), ...profile.patches]
// Embedding-host facts for ctx0 too (same public API as spawnWorld): worlds
// and ctx0 alike take no flags and never open a browser.
let fiber0
const ctx0 = await boot('aw-ctx0', join(profile.dir, 'cordis.yml'), patches, (ctx) => {
  provideCmdline(ctx, { args: ['--no-open', '--trusted-host', '192.168.31.130', '--trusted-host', '192.168.31.130:4998'], exit: () => { void fiber0?.dispose() } })
}, BARE)
fiber0 = ctx0.fiber

// ---- wait for the world targets (spawned by the adapter world plugins) ----
const routing = await import('../agent-hub/dist/index.js')
const wanted = ['omp', 'codex', 'claude', 'pi', 'hermes']
const ready = {}
for (let i = 0; i < 240; i++) {
  for (const key of wanted) if (routing.getTarget(key) !== undefined) ready[key] = true
  if (wanted.every((key) => ready[key] === true)) break
  await new Promise((r) => setTimeout(r, 500))
}
console.log(`[aw-smoke] roster=${JSON.stringify(routing.listAgents())} targets=${JSON.stringify(ready)}`)
console.log('[aw-smoke] SUPERD_KEEP=1 — servers stay up for acceptance')
