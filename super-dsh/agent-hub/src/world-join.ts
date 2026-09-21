/**
 * Hub-side world joiner (AW-B DL1–DL5) — `@pgmi-builds/agent-hub/join`.
 *
 * Ruling R2 (2026-09-16): an adapter may ship STANDALONE only — joining the
 * agent-worlds hub is the HUB side's job. This plugin is that job, generic:
 * the ctx0 composition inserts one row with `{ key }` and the hub does the
 * spawn/roster/mount wiring the adapter's own world plugin would otherwise
 * carry (the omp/codex adapters ship active per-adapter plugins; the claude
 * adapter's `/world` entry is deliberately inert and is joined HERE).
 *
 *   1. roster membership (activation IS membership, spec S2);
 *   2. ctx0 publishes the host mount (real webServer instance) before spawn;
 *   3. `spawnWorld` boots the sibling ROOT from the world's own nested home
 *      (`<home>/agents/<key>/profiles/web` — provisioned by the line
 *      bootstrap; the joiner never writes a profile), with the world mount
 *      patches (no listener, virtual webServer);
 *   4. the world's gateway becomes a foreign target; the carrier answers
 *      `/<key>/api` + `/<key>/api/remote.mux` in ctx0's auth domain.
 *
 * Cordis identifies a plugin by its module, so ONE joiner row per tree — a
 * second joined world needs either its own adapter-side plugin (omp/codex
 * shape) or this plugin promoted to per-row instances. The world's PROFILE
 * (bundles incl. its adapter) is the line bootstrap's responsibility; this
 * row only spawns, registers and mounts what that profile composes.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { registerAgent, setReady } from './roster.js'
import { registerForeignTarget } from './targets.js'
import { spawnWorld } from './spawn-world.js'
import { registerHostMount } from './world-host.js'
import { mountWorld } from './carrier.js'
import { worldMountPatches } from './world-mount.js'

/** Stable Cordis plugin name. */
export const name = 'aw.world.join'

/** Row config: which world to join, under which roster label. */
export interface Config {
  key: string
  label?: string
}

/** Structural slice of the ctx0 services the join needs. */
interface HostContext {
  provide(name: string, value: unknown): void
  inject(deps: string[], callback: (ctx: unknown) => void): unknown
  effect?(callback: () => () => void, label?: string): unknown
}

const ANCHOR = process.env.SUPERD_DSH_ANCHOR
  ?? '/home/u1/.local/lib/node_modules/@deepseek-ai/dsh/package.json'

/** Apply the join. @param ctx - the CTX0 root context. @param config - `{ key, label? }`. */
export function apply(ctx: HostContext, config?: Partial<Config>): void {
  const key = typeof config?.key === 'string' ? config.key : undefined
  if (key === undefined || key === '' || key.includes('/')) {
    ctx.provide('aw.world.join.error', `invalid config.key ${JSON.stringify(config?.key)}`)
    return
  }
  const label = typeof config?.label === 'string' && config.label !== '' ? config.label : key
  registerAgent({ key, label, ready: false })
  // S7 nested home: the world's whole tree lives under `agents/<key>` (its
  // profiles were provisioned there by the line bootstrap; DSH data lands
  // inside the same root via spawnWorld's dataHome override).
  const root = process.env.DSH_HOME ?? join(process.cwd(), '.tests', 'aw')
  const worldHome = join(root, 'agents', key)
  mkdirSync(join(worldHome, 'profiles'), { recursive: true })
  const world = (async () => {
    // Wait for ctx0's listening stack: the mount needs the real webServer and
    // the browser-trust fence from the live connection service.
    const host = await new Promise<Record<string, any>>((resolve) => {
      ctx.inject(['webServer', 'connection'], (hostCtx) => { resolve(hostCtx as Record<string, any>) })
    })
    const real = host['webServer']
    const connection = host['connection']
    const dropHostMount = registerHostMount({
      key,
      labelPath: `/${key}`,
      real,
      // ctx0's index gate, applied by the mount to this world's pages and
      // assets: the world is reached in-ctx and owns no listener, so ctx0
      // decides auth (one auth domain).
      authorize: (req, res) => (connection as { authorizeIndex(req: unknown, res: unknown): boolean }).authorizeIndex(req, res),
    })
    const ctxW = await spawnWorld({
      appName: `aw-${key}`,
      profileName: 'web',
      installAnchor: ANCHOR,
      home: worldHome,
      dataHome: worldHome,
      // Adapter-local bundle names resolve from the profile's own
      // node_modules (heal owns @deepseek-ai there; @pgmi-builds links are
      // provisioned by the line bootstrap/test setup).
      bareModuleBaseUrl: process.env.AW_BARE_BASE,
      extraPatches: worldMountPatches(key) as never,
    })
    const gateway = ctxW.get('typertGateway') as never
    registerForeignTarget({ key, gateway })
    const mounted = mountWorld({
      real,
      label: key,
      gateway,
      requestRejection: (request) => (connection as { requestRejection(req: unknown): number | undefined })
        .requestRejection(request),
    })
    setReady(key, true)
    ctx.effect?.(() => () => {
      mounted.dispose()
      dropHostMount()
    }, `aw.world.join: ${key} mount`)
    return ctxW
  })()
  ctx.provide(`aw.world.${key}`, world)
}

export default apply
