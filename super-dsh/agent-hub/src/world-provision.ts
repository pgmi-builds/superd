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
 * Link identity rule: both links point INSIDE the running line tree — the hub
 * at this module's own package root, the adapter at its sibling
 * `agent-<key>` directory — identical in the dev repo layout and inside the
 * published single `super-dsh` package, so ctx0 and every world root share
 * one hub/adapter instance with zero registry involvement.
 *
 * Returns the bare module base for `spawnWorld` (`…/profiles/node_modules/`),
 * or null when the adapter sibling does not exist next to the hub (a foreign
 * composition this module does not own — keep the caller's env/fallback path).
 */
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HUB_SCOPE = '@pgmi-builds'
const HARNESS_SCOPE = '@deepseek-ai'

/** The profile bundles every world tree composes besides its adapter. */
const WORLD_BASE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] as const

export interface ProvisionWorldOptions {
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
 * Provision one world's nested profile (idempotent: rewrites profile files,
 * re-links packages — lstat-safe against dangling links). Returns the
 * `bareModuleBaseUrl` for {@link spawnWorld}, or null when unresolvable.
 *
 * Never throws: any provisioning failure is logged and returns null so the
 * calling world plugin degrades to a not-ready roster row instead of failing
 * the loader entry — a failed apply would take down the whole host boot.
 */
export function provisionWorldProfile(opts: ProvisionWorldOptions): string | null {
  try {
    return provisionWorldProfileUnchecked(opts)
  } catch (cause) {
    console.error(`[super-dsh] provisioning world '${opts.key}' failed:`, cause)
    return null
  }
}

function provisionWorldProfileUnchecked(opts: ProvisionWorldOptions): string | null {
  // Single-pack topology: this module lives at `<line>/agent-hub/dist/`, and
  // every adapter is a SIBLING directory (`<line>/agent-<key>`) — the same
  // layout in the repo (dev link: lines) and inside the published `super-dsh`
  // package. The adapter link therefore points at the sibling; no registry
  // resolution is involved anywhere.
  const hubRoot = dirname(dirname(fileURLToPath(import.meta.url))) // <line>/agent-hub
  const lineRoot = dirname(hubRoot) // monolith root / repo super-dsh/
  const adapterDir = join(lineRoot, `agent-${opts.key}`)
  if (!existsSync(join(adapterDir, 'package.json'))) return null
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
  const linkRoot = join(opts.worldHome, 'profiles', 'node_modules')
  mkdirSync(join(linkRoot, HUB_SCOPE), { recursive: true })
  const links: ReadonlyArray<readonly [string, string]> = [
    [opts.adapterPkg.slice(HUB_SCOPE.length + 1), adapterDir],
    ['agent-hub', hubRoot],
  ]
  for (const [name, target] of links) {
    const dst = join(linkRoot, HUB_SCOPE, name)
    const st = lstatSync(dst, { throwIfNoEntry: false })
    if (st) rmSync(dst, { recursive: true, force: true })
    symlinkSync(target, dst)
  }
  // The harness scope rides along as ONE scope-level link into the first
  // `@deepseek-ai` directory visible from this module (the shared heal farm
  // in a dsh home, the repo farm in dev) — every `@deepseek-ai/*` row of the
  // world composition resolves through it without farming per package.
  for (const searchPath of createRequire(import.meta.url).resolve.paths(`${HARNESS_SCOPE}/x`) ?? []) {
    const scopeDir = join(searchPath, HARNESS_SCOPE)
    if (!existsSync(scopeDir)) continue
    const dst = join(linkRoot, HARNESS_SCOPE)
    const st = lstatSync(dst, { throwIfNoEntry: false })
    if (st) rmSync(dst, { recursive: true, force: true })
    symlinkSync(scopeDir, dst)
    break
  }
  return join(opts.worldHome, 'profiles', 'node_modules') + '/'
}
