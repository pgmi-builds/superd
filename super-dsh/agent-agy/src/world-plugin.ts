/**
 * aw.agent-adapter-agy — the Antigravity (agy) adapter's WORLD plugin (spec S2):
 * activation IS roster membership.
 *
 * AW-B URL scheme (DL1–DL5), mirroring `@pgmi-builds/agent-adapter-omp/world`
 * and `@pgmi-builds/agent-adapter-codex/world` so the hub sees every foreign
 * runtime through one shape: the world is spawned as a sibling ROOT context
 * with NO listener (`worldMountPatches`) and mounts itself under `/agy`.
 *
 *   1. ctx0 publishes the host mount (real webServer instance) before spawn;
 *   2. the world's entry row provides the virtual `webServer` in the world
 *      root, translating every route its plugins declare into `/agy+path`;
 *   3. the hub's carrier answers `/agy/api` + `/agy/api/remote.mux` in
 *      ctx0's auth domain and dispatches into this world's gateway instance.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  spawnWorld, registerAgent, setReady, registerForeignTarget,
  registerHostMount, mountWorld, worldMountPatches,
} from '@pgmi-builds/agent-hub'

export const name = 'aw.agent-adapter-agy'

/** Runtime key — also the mount label. */
const KEY = 'agy'

const ANCHOR = process.env.SUPERD_DSH_ANCHOR
  ?? '/home/u1/.local/lib/node_modules/@deepseek-ai/dsh/package.json'

/** Structural slice of the ctx0 services the mount needs. */
interface HostContext {
  provide(name: string, value: unknown): void
  inject(deps: string[], callback: (ctx: unknown) => void): unknown
  effect?(callback: () => () => void, label?: string): unknown
}

export function apply(ctx: HostContext): void {
  registerAgent({ key: KEY, label: 'Antigravity', ready: false })
  const root = process.env.DSH_HOME ?? join(process.cwd(), '.tests', 'aw')
  // Nested home: the world's DSH data lives INSIDE `agents/<label>` (sessions
  // / settings / workspaces, and the adapter's dsh-sessions.json mapping).
  // agy: RUNTIME data lives in the SDK (google-antigravity localharness reads is the native ~/.pi (2026-09-17 ruling) — ~/.gemini read-only). Nothing is
  // seeded or nested for the pi SDK itself.
  const worldHome = join(root, 'agents', KEY)
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
      key: KEY,
      labelPath: `/${KEY}`,
      real,
      // ctx0's index gate, applied by the mount to this world's pages and assets:
      // the world is reached in-ctx and owns no listener, so ctx0 decides auth.
      authorize: (req: unknown, res: unknown) => (connection as { authorizeIndex(req: unknown, res: unknown): boolean }).authorizeIndex(req, res),
    })
    const ctxW = await spawnWorld({
      appName: `aw-${KEY}`,
      profileName: 'web',
      installAnchor: ANCHOR,
      home: worldHome,
      dataHome: worldHome,
      // Adapter-local bundle names resolve from the profile's own
      // node_modules (heal owns @deepseek-ai there; @pgmi-builds links are
      // provisioned by the line bootstrap/test setup).
      bareModuleBaseUrl: process.env.AW_BARE_BASE,
      extraPatches: worldMountPatches(KEY) as never,
    })
    const gateway = ctxW.get('typertGateway') as never
    registerForeignTarget({ key: KEY, gateway })
    const mounted = mountWorld({
      real,
      label: KEY,
      gateway,
      requestRejection: (request: unknown) => (connection as { requestRejection(req: unknown): number | undefined })
        .requestRejection(request),
    })
    setReady(KEY, true)
    ctx.effect?.(() => () => {
      mounted.dispose()
      dropHostMount()
    }, `aw.agent-adapter-${KEY}: mount`)
    return ctxW
  })()
  ctx.provide(`aw.world.${KEY}`, world)
}
