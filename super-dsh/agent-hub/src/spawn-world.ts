/**
 * spawnWorld (S2): spawn a sibling ROOT context for a foreign agent world
 * from the CTX0 tree — the library form of the PoC (ADR 0008 mechanism,
 * .scratch/multi-context-poc/spawner2.mjs collapsed into a function).
 *
 * AW-A posture: SHARED home (ADR 0008 constraint 2 fallback). The ctxN
 * `dshHomePath` service override is an AW-C1 item (spec §三/§十一.2) — the
 * boot() provide/prepare ordering fact is pinned by
 * test/boot-prepare-ordering.test.mjs. Data detachment at this stage comes
 * from the adapter side (foreign app-home redirection, spec §七).
 *
 * Profile resolution: loadProfile(name, profileName, installAnchor, home)
 * reads profiles under `<home>/profiles/<profileName>` and heals the
 * `@deepseek-ai/*` fallback farm into `<home>/profiles/node_modules` from
 * the install anchor (single instance — same physical installation).
 */
import { loadProfile, boot } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export interface SpawnWorldOptions {
  /** App name for the spawned root (also its fiber label). */
  appName: string
  /** Profile directory name under `<home>/profiles/`. */
  profileName: string
  /** package.json of the @deepseek-ai installation that owns the bundle closure. */
  installAnchor: string
  /**
   * The world's own home root: profiles resolve from `<home>/profiles/<name>`.
   * The caller passes the NESTED root (`<line home>/agents/<label>`) — every
   * runtime owns one root, nothing is shared between runtimes.
   */
  home: string
  /**
   * The world's DSH data root (sessions / settings / workspaces). Defaults to
   * {@link home}. When it differs from `home`, the child tree's `dshHomePath`
   * service is overridden in the boot `prepare` slot — which runs AFTER boot's
   * own provide and BEFORE the plugin tree mounts, so every `!!js
   * dshHomePath(...)` expression in the composition resolves inside this root
   * (ADR 0008 constraint 2: per-context home can only be an in-tree service
   * override; `process.env` is a shared resolver).
   */
  dataHome?: string
  /** Extra patch layers appended after the profile's own (e.g. an adapter's insert row). */
  extraPatches?: Parameters<typeof boot>[2]
  /** Override the bare-name resolution base (defaults to the install anchor's node_modules). */
  bareModuleBaseUrl?: string
}

const EMPTY_ROOT = '[]\n'

export async function spawnWorld(opts: SpawnWorldOptions) {
  const profile = loadProfile(opts.appName, opts.profileName, opts.installAnchor, opts.home)
  // Empty include root: the tree is composed entirely as patch layers
  // (bundle rows in profile order + profile patch + extras).
  writeFileSync(join(profile.dir, 'cordis.yml'), EMPTY_ROOT)
  const patches = [
    ...profile.layers.flatMap((l) => l.patches),
    ...profile.patches,
    ...(opts.extraPatches ?? []),
  ]
  // Bare plugin names resolve from the installation's node_modules (the
  // anchor owns the complete plugin closure). Same cordis on both sides —
  // no cross-copy Symbol split.
  // Loader wants a file:// URL base; accept a plain path and normalize.
  const rawBase = opts.bareModuleBaseUrl ?? join(opts.installAnchor, '..', 'node_modules', '/')
  const bareModuleBaseUrl = rawBase.startsWith('file:')
    ? rawBase
    : pathToFileURL(rawBase.endsWith('/') ? rawBase : rawBase + '/').href
  // Embedding-host facts via the PUBLIC cmdline API (risk-2 probe: boot owns
  // dshHomePath, so the prepare slot is for OUR provides — cmdlineArgs is not
  // boot-provided and upstream documents the empty-args embedding path).
  // Worlds take no flags and never open a browser; exit = dispose own fiber.
  // LAN authorities for the world's trust fence (deploy-level, env-driven):
  // the world webserver must accept the Host the browser actually sends.
  const trusted = (process.env.AW_TRUSTED_HOSTS ?? '')
    .split(/[\s,]+/).filter(Boolean)
    .flatMap((h) => ['--trusted-host', h])
  let fiber: { dispose(): unknown } | undefined
  const ctxW = await boot(opts.appName, join(profile.dir, 'cordis.yml'), patches, (ctx) => {
    provideCmdline(ctx, {
      args: ['--no-open', ...trusted],
      exit: () => { void fiber?.dispose() },
    })
    // This tree reads its own home from here on: sessions, settings.yaml,
    // workspace store — all under the world's nested root.
    //
    // `set` (not `provide`): boot already registered `dshHomePath` on this
    // root, and cordis refuses a second `provide` in the same scope
    // ("service … has been registered at <root>"). `set` is the documented
    // "overwrite a provided service's value" path for the owning fiber, which
    // the prepare slot is — and ADR 0008 constraint 2 prescribes exactly this
    // in-tree override (process.env is a shared resolver and must not change).
    if (opts.dataHome !== undefined) {
      const dataHome = opts.dataHome
      ctx.set('dshHomePath', (...segments: string[]) => join(dataHome, ...segments))
    }
  }, bareModuleBaseUrl)
  fiber = ctxW.fiber
  return ctxW
}
