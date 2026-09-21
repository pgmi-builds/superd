/**
 * aw.agent-adapter-codex — the Codex adapter's WORLD plugin (spec S2):
 * activation IS roster membership.
 *
 * AW-B URL scheme (DL1–DL5), mirroring `@pgmi-builds/agent-adapter-omp/world`
 * so the hub sees both foreign runtimes through one shape: the world is spawned
 * as a sibling ROOT context with NO listener (`worldMountPatches`) and mounts
 * itself under `/codex` through the hub —
 *
 *   1. ctx0 publishes the host mount (real webServer instance) before spawn;
 *   2. the world's entry row provides the virtual `webServer` in the world
 *      root, translating every route its plugins declare into `/codex+path`;
 *   3. the hub's carrier answers `/codex/api` + `/codex/api/remote.mux` in
 *      ctx0's auth domain and dispatches into this world's gateway instance.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  spawnWorld, registerAgent, setReady, registerForeignTarget,
  registerHostMount, mountWorld, worldMountPatches, provisionWorldProfile,
} from '../../agent-hub/dist/index.js'

export const name = 'aw.agent-adapter-codex'

/** Runtime key — also the mount label. */
const KEY = 'codex'

const ANCHOR = process.env.SUPERD_DSH_ANCHOR
  ?? '/home/u1/.local/lib/node_modules/@deepseek-ai/dsh/package.json'

/** Structural slice of the ctx0 services the mount needs. */
interface HostContext {
  provide(name: string, value: unknown): void
  inject(deps: string[], callback: (ctx: unknown) => void): unknown
  effect?(callback: () => () => void, label?: string): unknown
}

export function apply(ctx: HostContext): void {
  registerAgent({ key: KEY, label: 'Codex', ready: false })
  const root = process.env.DSH_HOME ?? join(process.cwd(), '.tests', 'aw')
  // S7 nested home: every runtime owns one root under `agents/<label>`; the
  // world's DSH data lives INSIDE it (sessions / settings / workspaces) and the
  // foreign app's own store (`.codex`) sits in the same root.
  const worldHome = join(root, 'agents', KEY)
  mkdirSync(join(worldHome, 'profiles'), { recursive: true })
  // Publish story: a foreign install has no line bootstrap, so the nested
  // profile + @pgmi-builds links are provisioned HERE (idempotent; dev lines
  // keep parity — smoke.mjs wrote the same layout, and AW_BARE_BASE still
  // overrides the resolved base).
  const bareBase = provisionWorldProfile({
    key: KEY,
    adapterPkg: '@pgmi-builds/agent-adapter-codex',
    worldHome,
  })
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
      authorize: (req, res) => (connection as { authorizeIndex(req: unknown, res: unknown): boolean }).authorizeIndex(req, res),
    })
    const ctxW = await spawnWorld({
      appName: `aw-${KEY}`,
      profileName: 'web',
      installAnchor: ANCHOR,
      home: worldHome,
      dataHome: worldHome,
      // Adapter-local bundle names resolve from the profile's own
      // node_modules (heal owns @deepseek-ai there; @pgmi-builds links are
      // provisioned by provisionWorldProfile above, or by the line bootstrap
      // when the adapter package was not resolvable — env wins over both).
      bareModuleBaseUrl: process.env.AW_BARE_BASE ?? bareBase ?? undefined,
      extraPatches: worldMountPatches(KEY) as never,
    })
    const gateway = ctxW.get('typertGateway') as never
    registerForeignTarget({ key: KEY, gateway })
    const mounted = mountWorld({
      real,
      label: KEY,
      gateway,
      requestRejection: (request) => (connection as { requestRejection(req: unknown): number | undefined })
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
