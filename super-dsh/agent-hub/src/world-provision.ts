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
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

const HUB_SCOPE = '@pgmi-builds'
const HARNESS_SCOPE = '@deepseek-ai'

/** The profile bundles every world tree composes besides its adapter. */
const WORLD_BASE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] as const

/**
 * Resolve the running dsh installation's package.json — the anchor worlds
 * resolve `@deepseek-ai` bundles and the fallback closure from.
 *
 * Precedence: `$SUPERD_DSH_ANCHOR` (the repo dev lines' contract — the
 * launcher pins the checkout build), then a walk UP from the
 * `@deepseek-ai/dsh-app-boot` this module resolved (the host always provides
 * it) to the nearest ancestor package named `@deepseek-ai/dsh` — the
 * packaged-install layout (`<install>/@deepseek-ai/dsh/node_modules/
 * @deepseek-ai/dsh-app-boot`) lands on the install root in two hops. No
 * machine-specific path ships in code.
 * @throws when neither yields an installation (mis-launched composition).
 */
export function resolveInstallAnchor(): string {
  const fromEnv = process.env.SUPERD_DSH_ANCHOR
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  let dir = dirname(resolveHostPackageDir('@deepseek-ai/dsh-app-boot'))
  while (true) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) {
      try {
        const name = (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }).name
        if (name === '@deepseek-ai/dsh') return manifest
      } catch { /* malformed intermediate manifest — keep walking */ }
    }
    const parent = dirname(dir)
    if (parent === dir) {
      throw new Error('super-dsh: cannot derive the dsh installation anchor (set SUPERD_DSH_ANCHOR)')
    }
    dir = parent
  }
}

/** First `node_modules` search-path candidate that exists for a specifier,
 *  resolved to its REALPATH — farm and pnpm links must not leak into the
 *  ancestor walk (the install tree only exists behind the symlink). */
function resolveHostPackageDir(spec: string): string {
  for (const searchPath of createRequire(import.meta.url).resolve.paths(`${spec}/x`) ?? []) {
    const candidate = join(searchPath, spec)
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
  }
  throw new Error(`super-dsh: cannot resolve ${spec} from the running host`)
}

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


/**
 * A source-checkout (pnpm workspace) splits the @deepseek-ai closure across
 * the workspace packages' OWN node_modules (apps/cli links only its direct
 * deps; bundle/web-app carries the UI closure, bundle/base the runtimes).
 * When the anchor sits inside a pnpm workspace, every package-level scope is
 * a union source. Packaged installs have no pnpm-workspace.yaml and return
 * nothing — their single install tree is already complete (dev3 evidence).
 */
function workspaceHarnessScopes(anchorDir: string): string[] {
  let root: string | undefined = anchorDir
  while (root !== undefined && !existsSync(join(root, 'pnpm-workspace.yaml'))) {
    const parent = dirname(root)
    root = parent === root ? undefined : parent
  }
  if (root === undefined) return []
  const scopes: string[] = []
  const collect = (base: string, depth: number): void => {
    if (!existsSync(base)) return
    const scope = join(base, 'node_modules', HARNESS_SCOPE)
    if (existsSync(scope)) scopes.push(scope)
    if (depth === 0) return
    for (const entry of readdirSync(base)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue
      // Bare files under group dirs (packages/AGENTS.md — the docs/06 §2.1
      // phantom-package trap) must not abort the whole enumeration.
      if (!statSync(join(base, entry), { throwIfNoEntry: false })?.isDirectory()) continue
      collect(join(base, entry), depth - 1)
    }
  }
  collect(join(root, 'packages'), 2)
  collect(join(root, 'vendor'), 1)
  collect(join(root, 'apps'), 1)
  return scopes
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
  // The harness scope for the world tree is a REAL scope directory of
  // per-package symlinks UNIONED from two authoritative sources (farm first,
  // installation fills the gaps — dev3 evidence: farm 244 entries missing 16
  // newer packages the install's 260 has; ctx0 survives via the app-boot
  // install-anchored resolver fallback, but a tree with an explicit bare
  // base gets no such fallback). A single scope-level link cannot express
  // that union, and a resolve.paths() walk from this module can pick the
  // PROFILE's own partial pnpm scope (2 entries on dev3) — never use it.
  const ANCHOR = resolveInstallAnchor()
  const scopeSources = [
    join(resolveDshHome(), 'profiles', 'node_modules', HARNESS_SCOPE),
    join(dirname(ANCHOR), 'node_modules', HARNESS_SCOPE),
    ...workspaceHarnessScopes(dirname(ANCHOR)),
  ]
  const scopeDst = join(linkRoot, HARNESS_SCOPE)
  rmSync(scopeDst, { recursive: true, force: true })
  mkdirSync(scopeDst, { recursive: true })
  const linked = new Set<string>()
  for (const scopeSrc of scopeSources) {
    if (!existsSync(scopeSrc)) continue
    for (const name of readdirSync(scopeSrc)) {
      if (name.startsWith('.') || linked.has(name)) continue
      symlinkSync(join(scopeSrc, name), join(scopeDst, name))
      linked.add(name)
    }
  }
  return join(opts.worldHome, 'profiles', 'node_modules') + '/'
}
