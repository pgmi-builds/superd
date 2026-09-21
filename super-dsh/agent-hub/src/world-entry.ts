/**
 * World-side mount plugin (AW-B DL1/DL3) — `@pgmi-builds/agent-hub/world`.
 *
 * Inserted into the WORLD root's composition (its own process-side root, no
 * listener). It provides the virtual `webServer` for that root: every route the
 * world's plugins register is translated to `/<label>+path` on ctx0's real
 * webServer, so the world's whole web surface lands under its mount with no
 * namespace list and no second socket.
 *
 * The RPC channel is NOT the world's: `WorldWebServer` swallows `/api*`, and the
 * hub's carrier answers `/<label>/api` + `/<label>/api/remote.mux` in ctx0's
 * auth domain, dispatching to this world's gateway instance. Non-envelope
 * GET/HEAD traffic on `/<label>/api` is forwarded into the world's registered
 * exact Fetch routes (session-log export and friends) through the shared
 * `/api` fetch handler this plugin publishes into the cross-root registry
 * (`world-host.ts`) — still behind ctx0's fence, never the world's own.

 * auth domain, dispatching to this world's gateway instance.
 */
import type { Context } from '@deepseek-ai/cordis'
import { noteWorldServer, publishWorldFetch, takeHostMount, type WorldFetchHandler } from './world-host.js'
import { WorldWebServer } from './world-web-server.js'

/** Stable Cordis plugin name. */
export const name = 'aw.world.mount'

/** Row config: which world this root is. */
export interface Config {
  key: string
}

/** Apply the world mount. @param ctx - the WORLD root context. @param config - `{ key }`. */
export function apply(ctx: Context, config?: { key?: unknown }): void {
  const key = typeof config?.key === 'string' ? config.key : undefined
  if (key === undefined) {
    ctx.logger?.warn?.('aw.world.mount: missing config.key — world not mounted')
    return
  }
  const mount = takeHostMount(key)
  if (mount === undefined) {
    ctx.logger?.warn?.(`aw.world.mount: no host mount registered for key ${JSON.stringify(key)}`)
    return
  }
  const worldWebServer = new WorldWebServer(mount.labelPath, mount.real, {
    onIndexInject: (table) => { ctx.emit('webserver/index-inject', table) },

    // One auth domain: the mount, not this world, decides who may read a page.
    authorize: (req, res) => mount.authorize?.(req, res) ?? true,
  })
  noteWorldServer(key, worldWebServer)
  ctx.reflect.provide('webServer', worldWebServer)
  // The world's frontend-static still asks ITS OWN connection to authorize an
  // index request. That gate is answered by the mount above: the browser came
  // in through ctx0, the world is reached in-ctx, and the world's cookie secret
  // belongs to its own nested home — so a second check here could only 401 an
  // already-authorized read. Neutralize it instead of sharing credentials.
  // The same connection also composes the world's `/api` fetch handler (exact
  // Fetch routes + the gateway's RPC interceptor). It is published here so the
  // hub's carrier can forward non-envelope GET/HEAD traffic on
  // `/<label>/api` into the world's registered routes; auth stays in ctx0's
  // domain because the carrier fences the request BEFORE this handler runs.
  let dropWorldFetch: (() => void) | undefined
  ctx.inject(['connection'], (webCtx) => {
    const connection = webCtx.get('connection') as {
      authorizeIndex?: (...rest: unknown[]) => boolean
      createSharedFetchHandler?: (channel: string) => WorldFetchHandler
    } | undefined
    if (connection === undefined) return
    if (typeof connection.authorizeIndex === 'function') {
      connection.authorizeIndex = () => true
    }
    if (typeof connection.createSharedFetchHandler === 'function') {
      dropWorldFetch = publishWorldFetch(key, connection.createSharedFetchHandler('/api'))
    }
  })
  ctx.effect(() => () => {
    worldWebServer.dispose()
    dropWorldFetch?.()
  }, 'aw.world.mount: virtual webServer')

}

export default apply
