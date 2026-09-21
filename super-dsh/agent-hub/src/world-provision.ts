/**
 * Nested-world profile provisioning — the publish story.
 *
 * The dev line (test/smoke.mjs) hand-provisions every world's nested profile
 * (`<home>/agents/<label>/profiles/web`) and the `@pgmi-builds/*` links its
 * resolution needs. A foreign install has NO line bootstrap:
 *
 *   dsh plugin --profile <name> add super-dsh
 *
 * mounts the hub + adapter world plugins into the consumer's profile, and the
 * spawn call sites (adapter world-plugins, hub join) must provision the same
 * layout THEMSELVES or every world spawn fails on a missing profile.
 *
 * This module is the library form of that bootstrap, called by all six spawn
 * sites. Layout invariants (super-dsh/AGENTS.md S7, smoke.mjs parity):
 *
 *   - `<worldHome>/profiles/web/package.json` — bundles `[dsh-base, dsh-web-app,
 *     adapterPkg]`; the world tree is a full sibling root, nothing shared.
 *   - `<worldHome>/profiles/web/cordis.patch.yml` — per-world home pinning:
 *     every home-resolving DSH plugin reads THIS tree's nested root.
 *   - `<worldHome>/profiles/node_modules/@pgmi-builds/{adapter,hub}` — links
 *     for the profile's bundle resolution and the inserted mount rows
 *     (`@deepseek-ai/*` is loadProfile's heal farm, not ours).
 *
 * Link identity rule: the HUB link targets the copy THIS module's own package
 * resolved (self-resolution via import.meta.url — canonical in dev repo layout
 * and in registry installs alike), and the ADAPTER link targets the copy the
 * CALLING world plugin resolved. Both equal what the spawning tree already
 * loaded, so ctx0 and every world root share one hub/adapter instance.
 *
 * Returns the bare module base for `spawnWorld` (`…/profiles/node_modules/`),
 * or null when the adapter package cannot be resolved from the caller — which
 * in practice means the dev line is running with an external bootstrap
 * (smoke.mjs provisioned everything already; keep its AW_BARE_BASE behavior).
 */
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HUB_PKG = '@pgmi-builds/agent-hub'
const HUB_SCOPE = '@pgmi-builds'

/** The profile bundles every world tree composes besides its adapter. */
const WORLD_BASE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] as const

export interface ProvisionWorldOptions {
  /** `import.meta.url` of the CALLING world plugin (adapter or hub join). */
  callerUrl: string
  /** Runtime key — also the mount label and the `agents/<key>` home segment. */
  key: string
  /** The adapter's own package name (the world profile's third bundle). */
  adapterPkg: string
  /** Nested home root: `<DSH_HOME>/agents/<key>`. */
  worldHome: string
  /** Profile directory name under `<worldHome>/profiles`. Default `'web'`. */
  profileName?: string
}

/**
 * Resolve a package's directory exactly as Node would from `fromUrl`.
 *
 * Walks `resolve.paths()` candidates instead of resolving
 * `<spec>/package.json`: our packages (like upstream's) do not export
 * `./package.json`, so the subpath resolve fails with
 * ERR_PACKAGE_PATH_NOT_EXPORTED even when the package is plainly there.
 */
function resolvePackageDir(fromUrl: string, spec: string): string | undefined {
  for (const searchPath of createRequire(fromUrl).resolve.paths(spec) ?? []) {
    const candidate = join(searchPath, spec)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

/**
 * Provision one world's nested profile (idempotent: rewrites profile files,
 * re-links packages — lstat-safe against dangling links). Returns the
 * `bareModuleBaseUrl` for {@link spawnWorld}, or null when unresolvable.
 */
export function provisionWorldProfile(opts: ProvisionWorldOptions): string | null {
  const adapterDir = resolvePackageDir(opts.callerUrl, opts.adapterPkg)
  if (adapterDir === undefined) return null
  // Self-resolution: this module lives in the hub's own dist, so the hub
  // package root is always reachable from here — canonical in both layouts.
  const hubDir = dirname(fileURLToPath(import.meta.url)) // <hub>/dist
  const profileName = opts.profileName ?? 'web'
  const profDir = join(opts.worldHome, 'profiles', profileName)
  mkdirSync(profDir, { recursive: true })
  writeFileSync(
    join(profDir, 'package.json'),
    JSON.stringify(
      {
        name: `aw-${opts.key}-world-profile`,
        private: true,
        dsh: { profile: { bundles: [...WORLD_BASE_BUNDLES, opts.adapterPkg] } },
      },
      null,
      2,
    ) + '\n',
  )
  // Per-world home pinning (smoke.mjs parity): settings, credentials,
  // attachments, shell env and skills all land inside `agents/<key>/`.
  // (`agent-instructions` keeps its base `maxBytes` home — instruction
  // discovery root, not agent data.)
  writeFileSync(
    join(profDir, 'cordis.patch.yml'),
    [
      '# Per-world home pinning (dshHomePath is this tree\'s nested home).',
      ...['settings', 'credentials', 'attachment-local', 'shell-env', 'skill-filesystem'].flatMap(
        (id) => [`- id: ${id}`, '  config:', '    dshHome: !!js dshHomePath()'],
      ),
      '',
    ].join('\n'),
  )
  // @pgmi-builds links for the world tree's bare-name resolution (profile
  // bundles + the inserted mount rows). Dangling links first (lstat:
  // existsSync is false for them, which skipped rmSync and crashed
  // symlinkSync with EEXIST after repo moves).
  const linkRoot = join(opts.worldHome, 'profiles', 'node_modules', HUB_SCOPE)
  mkdirSync(linkRoot, { recursive: true })
  const links: ReadonlyArray<readonly [string, string]> = [
    [opts.adapterPkg.slice(HUB_SCOPE.length + 1), adapterDir],
    ['agent-hub', hubDir],
  ]
  for (const [name, target] of links) {
    const dst = join(linkRoot, name)
    const st = lstatSync(dst, { throwIfNoEntry: false })
    if (st) rmSync(dst, { recursive: true, force: true })
    symlinkSync(target, dst)
  }
  return join(opts.worldHome, 'profiles', 'node_modules') + '/'
}
