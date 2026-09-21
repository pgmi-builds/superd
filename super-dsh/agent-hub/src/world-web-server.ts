/**
 * Per-world virtual webServer (AW-B DL3).
 *
 * A world's plugins must be able to declare ANY path they like (`/api`,
 * `/plugins`, `/whatever-name-i-like`). Enumerating those namespaces in the
 * carrier is wrong by construction — a third-party plugin may declare a new
 * one at any time. So this class translates at REGISTRATION time:
 *
 *   world registers  { kind, path }        →  real registers { kind, `${labelPath}${path}` }
 *   real receives    /<label>/<path>/...   →  plugin handler sees /<path>/...
 *
 * Consequences:
 *  - any declared prefix lands under the label automatically; no list;
 *  - two worlds may both own `/api` (they become `/omp/api`, `/codex/api`);
 *  - ctx0 only ever sees the label namespaces, so a world cannot collide with
 *    ctx0's own routes.
 *
 * Index rows stay world-local: this instance owns its taps and emits nothing
 * on the shared tree (worlds run as their own cordis ROOTS, whose event buses
 * are isolated — probe 2026-09-16: emit on root B never reaches root A).
 */
import { renderIndexInjections, type IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { rewriteIndexHtml } from './index-pass.js'
import { renderClientShim } from './client-shim.js'
import { agentRosterRow } from './agent-roster.js'

/** Route match kind (mirrors the upstream contract). */
export type WebRouteKind = 'exact' | 'prefix'

/** The slice of node:http we touch (kept structural for testability). */
export interface WorldRequest { url?: string }
export interface WorldResponse {
  writeHead(status: number, headers: Record<string, string>): unknown
  end(...args: unknown[]): unknown
}

/** A world route handler as plugins write it. */
export type WorldHandler = (req: WorldRequest, ...rest: never[]) => void | Promise<void>

/** One named route registration (structural mirror of the upstream type). */
export interface WorldWebRoute {
  kind: WebRouteKind
  path: string
  handler: (req: WorldRequest, res: WorldResponse) => void | Promise<void>
}

/** One exact-path HTTP upgrade registration. */
export interface WorldWebUpgradeRoute {
  path: string
  handler: (req: WorldRequest, socket: unknown, head: Buffer) => void | Promise<void>
}

/** The real (ctx0) webServer surface this world forwards into. */
export interface RealWebServerFace {
  register(route: { kind: WebRouteKind; path: string; handler: never }): () => void
  registerUpgrade(route: { path: string; handler: never }): () => void
  registerFallback(handler: never): () => void
  tapIndex?(transform: (html: string) => string): () => void
  readonly port?: number
  readonly host?: string
}

/** Options: how this world collects its own index rows. */
export interface WorldWebServerOptions {
  /**
   * Push the world's index injection rows. The world plugin supplies a
   * function that emits on the WORLD root (never on ctx0's tree).
   */
  onIndexInject?(table: IndexInjection[]): void
  /**
   * ctx0's index authorization, applied to every route this mount forwards
   * (pages, assets, fallback): the SAME gate native uses, so one cookie opens
   * everything under the origin. The world owns no listener and the browser
   * reaches it only through this mount, so authentication is decided HERE, in
   * ctx0's auth domain — never by the world's own browser-auth gate. A false
   * return means the authorizer already wrote the response (401 / 303).
   */
  authorize?(req: WorldRequest, res: WorldResponse): boolean
}

function translatePath(labelPath: string, path: string): string {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new Error(`world-web-server: route path must start with "/", got ${JSON.stringify(path)}`)
  }
  return path === '/' ? labelPath : `${labelPath}${path}`
}

/** Remove the mount label from `req.url`, preserving the trailing query. */
export function stripLabelFromUrl(url: string | undefined, labelPath: string): string {
  const raw = typeof url === 'string' && url !== '' ? url : '/'
  const queryAt = raw.indexOf('?')
  const path = queryAt === -1 ? raw : raw.slice(0, queryAt)
  const rest = queryAt === -1 ? '' : raw.slice(queryAt)
  if (path === labelPath) return `/${rest}`
  if (path.startsWith(`${labelPath}/`)) return `${path.slice(labelPath.length)}${rest}`
  return raw
}

/** One world's web surface, mounted under `<labelPath>`. */
export class WorldWebServer {
  private readonly disposers: Array<() => void> = []
  private readonly taps: Array<(html: string) => string> = []

  /**
   * @param labelPath - mount root, e.g. `/omp` (no trailing slash).
   * @param real - the ctx0 webServer this world's routes forward into.
   * @param options - world-local index row source.
   */
  constructor(
    readonly labelPath: string,
    private readonly real: RealWebServerFace,
    private readonly options: WorldWebServerOptions = {},
  ) {
    if (typeof labelPath !== 'string' || !labelPath.startsWith('/') || labelPath === '/' || labelPath.endsWith('/')) {
      throw new Error(`world-web-server: labelPath must start with "/" and carry no trailing slash, got ${JSON.stringify(labelPath)}`)
    }
  }

  /** The ctx0 listener port (read-through; the world owns no socket). */
  get port(): number {
    return this.real.port ?? 0
  }

  /** The ctx0 bind host (read-through). */
  get host(): string {
    return this.real.host ?? '127.0.0.1'
  }

  /**
   * The RPC channel belongs to the HUB, not to the world: the hub's carrier
   * answers `/<label>/api/*` and `/<label>/api/remote.mux` with ctx0's auth
   * domain, so the world's own connection/gateway registrations are swallowed
   * here (returning a no-op disposer) instead of colliding on the real table.
   * Non-envelope GET/HEAD traffic on `/<label>/api` still reaches the world's
   * exact Fetch routes: `world-entry` publishes the world connection's shared
   * `/api` fetch handler through `world-host`, and the carrier forwards into
   * it AFTER ctx0's fence — the world's own browser-auth gate is never in the
   * path (a different tree, a different secret).
   */
  private static hubOwned(path: string): boolean {
    return path === '/api' || path.startsWith('/api/')
  }

  /**
   * Mount-side authentication for one forwarded world route.
   *
   * The world's own browser-auth gate never sees a browser: it is reached
   * in-ctx through this mount, and its cookie secret belongs to a different
   * tree (every runtime is nested with its own home). So the decision is made
   * here, with ctx0's connection: the same cookie that authenticated `<label>`
   * in ctx0 authorizes its pages and assets.
   */
  private gate(handler: WorldHandler): WorldHandler {
    return (req: WorldRequest, ...rest: never[]): void | Promise<void> => {
      const res = rest[0] as unknown as WorldResponse | undefined
      // false => the authorizer already answered (401, or token→cookie 303).
      if (res !== undefined && this.options.authorize !== undefined
        && !this.options.authorize(req, res)) return
      return handler(req, ...rest)
    }
  }

  /** Register a world route; the real table stores its translated path. */
  register(route: WorldWebRoute): () => void {
    if (WorldWebServer.hubOwned(route.path)) return () => {}
    return this.track(this.real.register({
      kind: route.kind,
      path: translatePath(this.labelPath, route.path),
      handler: this.strip(this.gate(route.handler)) as never,
    }))
  }

  /** Register a world upgrade route (verbatim exact path; hub-owned RPC paths are swallowed). */
  registerUpgrade(route: WorldWebUpgradeRoute): () => void {
    if (WorldWebServer.hubOwned(route.path)) return () => {}
    return this.track(this.real.registerUpgrade({
      path: translatePath(this.labelPath, route.path),
      handler: this.strip(route.handler as WorldHandler) as never,
    }))
  }

  /**
   * Claim the world's SPA fallback: the ctx0 fallback seat is already owned by
   * native frontend-static, so the world's fallback lives as a PREFIX route on
   * the mount path (`/<label>`), which also keeps it inside the label namespace.
   */
  registerFallback(handler: (req: WorldRequest, res: WorldResponse) => void | Promise<void>): () => void {
    // The world's index arrives HERE (its own frontend-static claims the
    // fallback seat), so this is the route the mount must authenticate.
    const gated = this.gate((req: WorldRequest, ...rest: never[]) => handler(req, rest[0] as WorldResponse)) as never
    return this.track(this.real.register({
      kind: 'prefix',
      path: this.labelPath,
      handler: this.htmlRewrite(this.strip(gated)) as never,
    }))
  }

  /**
   * Fix up HTML on its way out. Two passes belong here, in this order:
   *
   *   1. the world's own frontend-static injects `<base href="/">` AFTER
   *      `renderIndex`, and the FIRST `<base>` wins in a document, so the mount
   *      base is re-pinned on the bytes actually sent;
   *   2. the agent roster is injected LAST — its values are the mount paths of
   *      OTHER worlds (`/`, `/omp/`, `/codex/`), which the mount pass above
   *      would otherwise re-root under this world's label.
   */
  private htmlRewrite(handler: WorldHandler): WorldHandler {
    const labelPath = this.labelPath
    return (req: WorldRequest, ...rest: never[]): void | Promise<void> => {
      const res = rest[0] as { end?: (...args: unknown[]) => unknown } | undefined
      const originalEnd = res?.end?.bind(res)
      if (res !== undefined && originalEnd !== undefined) {
        res.end = ((chunk?: unknown, ...tail: unknown[]) => {
          if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) {
            const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
            if (/<head[\s>]/i.test(text) && /<base\b/i.test(text)) {
              const mounted = rewriteIndexHtml(text, labelPath)
              // A world that composes the hub row emits its own roster row during
              // renderIndex — i.e. BEFORE this mount pass, so its paths were
              // already re-rooted. Drop every earlier copy and inject the one
              // this pass has just built from unrewritten values.
              const stale = /<script>globalThis\["__DSH_AGENT_ROSTER__"\][^<]*<\/script>/g
              const cleaned = mounted.replace(stale, '')
              return originalEnd(renderIndexInjections(cleaned, [agentRosterRow()]), ...tail)
            }
          }
          return originalEnd(chunk, ...tail)
        }) as never
      }
      return handler(req, ...rest)
    }
  }

  /** World-local raw index transform (never forwarded to ctx0's taps). */
  tapIndex(transform: (html: string) => string): () => void {
    this.taps.push(transform)
    return () => {
      const at = this.taps.indexOf(transform)
      if (at !== -1) this.taps.splice(at, 1)
    }
  }

  /** Apply this world's taps in registration order. */
  applyIndexTaps(html: string): string {
    let out = html
    for (const transform of this.taps) out = transform(out)
    return out
  }

  /** Collect this world's structured rows (supplied by the world root). */
  collectIndexInjections(): IndexInjection[] {
    const table: IndexInjection[] = []
    this.options.onIndexInject?.(table)
    return table
  }

  /**
   * Render the world's index: the client mount shim first (it must run before
   * the app entry module), then the world's rows, then its taps, then the mount
   * pass (base pinned at `/<label>/`, root-absolute strings re-rooted).
   *
   * The agent roster is injected LAST, after the mount pass: its values are
   * mount paths of OTHER worlds (`/`, `/omp/`, `/codex/`), and the pass would
   * happily re-root them under this world's label.
   */
  renderIndex(html: string): string {
    const rows: IndexInjection[] = [
      { kind: 'script', placement: 'head', text: renderClientShim(this.labelPath) },
      // No hub-invented widget here: the world composes the hub's own client
      // plugin (see worldMountPatches), so its selector IS the native one.
      ...this.collectIndexInjections(),
    ]
    const rendered = this.applyIndexTaps(renderIndexInjections(html, rows))
    // The roster rides the outbound pass (htmlRewrite), not this one: the mount
    // rewrite above would re-root other worlds' paths under this label.
    return rewriteIndexHtml(rendered, this.labelPath)
  }

  /** Unregister every translated route (world unloaded). */
  dispose(): void {
    for (const dispose of this.disposers.splice(0).reverse()) {
      try {
        dispose()
      } catch {
        // release must never throw during teardown
      }
    }
    this.taps.length = 0
  }

  /** Wrap a plugin handler so it sees the world-relative URL. */
  private strip(handler: WorldHandler): WorldHandler {
    const labelPath = this.labelPath
    return (req: WorldRequest, ...rest: never[]): void | Promise<void> => {
      req.url = stripLabelFromUrl(req.url, labelPath)
      return handler(req, ...rest)
    }
  }

  private track(dispose: () => void): () => void {
    const wrapped = (): void => {
      const at = this.disposers.indexOf(wrapped)
      if (at !== -1) this.disposers.splice(at, 1)
      dispose()
    }
    this.disposers.push(wrapped)
    return wrapped
  }
}
