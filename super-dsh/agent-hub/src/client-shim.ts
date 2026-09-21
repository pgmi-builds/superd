/**
 * Client mount shim (AW-B DL8).
 *
 * ONE head script installs every client-side break point:
 *   - `__DSH_TRANSPORT__.fetch`  → the Connection RPC fetch (URL object input)
 *   - `WebSocket` / `EventSource` / `XMLHttpRequest` constructors → path rewrite
 *   - `__DSH_FILE_UPLOAD__`      → uploads bypass the blob worker + its XHR
 *   - Storage.prototype get/set/remove → per-world key namespace
 *   - `globalThis.fetch`         → global-fetch calls asking for ctx0-root `/api`
 *     URLs (2026-09-17 H1: upstream session-log-export resolves the GLOBAL
 *     fetch at call time; narrow `/api`-only rule, query + hash preserved)
 *   - `HTMLAnchorElement.prototype.click` → download-anchor clicks re-rooted
 *     (2026-09-18 H1 r2: upstream hands the UNREWRITTEN absolute URL to a
 *     DETACHED `<a download>` and clicks it — detached clicks never reach
 *     document, so a document-level listener cannot see them, and a blanket
 *     rewrite breaks the runtime selector's root-absolute anchors
 *     (live-found 2026-09-18). Narrow rule: ONLY anchors carrying a
 *     `download` attribute AND a same-authority root-absolute `/api` href.)
 * The rule is namespace-agnostic: a same-origin root-absolute URL is re-rooted
 * under the mount (`/omp`), nothing else is touched. That covers every prefix
 * a plugin may declare later — no list to keep in sync.
 */

/** Escape a label for embedding in generated JavaScript. */
function js(value: string): string {
  return JSON.stringify(value)
}

/**
 * Render the shim as a classic script (parser-blocking head injection).
 * @param labelPath - mount root, e.g. `/omp`.
 * @returns JavaScript source.
 */
export function renderClientShim(labelPath: string): string {
  if (typeof labelPath !== 'string' || !labelPath.startsWith('/') || labelPath === '/' || labelPath.endsWith('/')) {
    throw new Error(`client-shim: labelPath must start with "/" and carry no trailing slash, got ${JSON.stringify(labelPath)}`)
  }
  const prefix = `${labelPath}/`
  return `(() => {
  const LABEL = ${js(labelPath)}
  const PREFIX = ${js(prefix)}

  /** Re-root one pathname when it is same-origin root-absolute and not mounted yet. */
  const rewritePath = (path) => {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return path
    if (path === LABEL || path.startsWith(PREFIX)) return path
    return PREFIX + path.slice(1)
  }

  const origin = () => {
    const loc = globalThis.location
    if (loc !== undefined && typeof loc.origin === 'string' && loc.origin !== 'null') return loc.origin
    return 'http://dsh.internal'
  }

  /** Same authority as the page (scheme-agnostic: ws/wss/http/https share host). */
  const sameAuthority = (url) => {
    try {
      return url.host === new URL(origin()).host
    } catch {
      return false
    }
  }

  /** Rewrite a full URL (absolute or relative); other authorities are untouched. */
  const rewriteUrl = (input) => {
    if (typeof input === 'string') {
      if (input.startsWith('/')) return rewritePath(input)
      try {
        const url = new URL(input, origin())
        if (!sameAuthority(url)) return input
        const next = rewritePath(url.pathname)
        if (next === url.pathname) return input
        url.pathname = next
        return url.href
      } catch {
        return input
      }
    }
    if (input !== null && typeof input === 'object' && typeof input.href === 'string') {
      try {
        const url = new URL(input.href)
        if (!sameAuthority(url)) return input
        const next = rewritePath(url.pathname)
        if (next === url.pathname) return input
        url.pathname = next
        return url
      } catch {
        return input
      }
    }
    return input
  }

  const nativeFetch = globalThis.fetch
  const shimFetch = (input, init) => {
    if (typeof nativeFetch !== 'function') throw new Error('client-shim: fetch is unavailable')
    if (typeof Request === 'function' && input instanceof Request) {
      const url = rewriteUrl(input.url)
      return nativeFetch(url === input.url ? input : new Request(url, input), init)
    }
    return nativeFetch(rewriteUrl(input), init)
  }

  const transport = (globalThis.__DSH_TRANSPORT__ = globalThis.__DSH_TRANSPORT__ || {})
  transport.rewrite = rewritePath
  transport.fetch = shimFetch

  // Construct through a Proxy, never a hand-rolled wrapper function: the
  // upstream client compares socket.readyState against WebSocket.OPEN, so the
  // native statics (CONNECTING/OPEN/CLOSING/CLOSED), prototype and instanceof
  // must survive the interception.
  const NativeWebSocket = globalThis.WebSocket
  if (typeof NativeWebSocket === 'function') {
    globalThis.WebSocket = new Proxy(NativeWebSocket, {
      construct: (Target, args) => new Target(rewriteUrl(args[0]), ...args.slice(1)),
    })
  }

  const NativeEventSource = globalThis.EventSource

  if (typeof NativeEventSource === 'function') {
    globalThis.EventSource = new Proxy(NativeEventSource, {
      construct: (Target, args) => new Target(rewriteUrl(args[0]), ...args.slice(1)),
    })
  }

  const NativeXhr = globalThis.XMLHttpRequest
  if (typeof NativeXhr === 'function' && NativeXhr.prototype !== undefined && typeof NativeXhr.prototype.open === 'function') {
    const nativeOpen = NativeXhr.prototype.open
    NativeXhr.prototype.open = function (method, url, ...rest) {
      return nativeOpen.call(this, method, rewriteUrl(url), ...rest)
    }
  }

  // Read by the file-upload service at construction time: present ⇒ the page
  // fetch carries uploads (no blob worker, and therefore no worker-scope XHR).
  globalThis.__DSH_FILE_UPLOAD__ = { fetch: shimFetch }

  // Narrow '/api' re-root helpers (2026-09-17 session-log 404, H1): upstream
  // client code (session-log-export) resolves the GLOBAL fetch at call time
  // and hands absolute ctx0-root URLs both to fetch and to a DETACHED
  // download anchor — neither is visible to the transport faces above.
  // Narrow rule: only root-absolute '/api' paths move under the mount;
  // relative, same-mount, and foreign URLs pass through untouched. Query and
  // hash survive because only the pathname is rewritten. The mount root comes
  // from this shim's argument, never from location.pathname. NOTE: the '/api'
  // literals below stay SINGLE-quoted on purpose — index-pass.ts rewrites
  // every DOUBLE-quoted root-absolute string in the served HTML, and a
  // doubled literal would silently disable these rewrites (regression tests
  // survive the mount HTML pass).
  const rewriteApiPath = (path) => {
    if (path === '/api' || path.startsWith('/api/')) return PREFIX + path.slice(1)
    return path
  }
  const rewriteApiUrl = (input) => {
    if (typeof input === 'string') {
      if (input.startsWith('/') && !input.startsWith('//')) return rewriteApiPath(input)
      try {
        const url = new URL(input, origin())
        if (!sameAuthority(url)) return input
        const next = rewriteApiPath(url.pathname)
        if (next === url.pathname) return input
        url.pathname = next
        return url.href
      } catch {
        return input
      }
    }
    if (input !== null && typeof input === 'object' && typeof input.href === 'string') {
      try {
        const url = new URL(input.href)
        if (!sameAuthority(url)) return input
        const next = rewriteApiPath(url.pathname)
        if (next === url.pathname) return input
        url.pathname = next
        return url
      } catch {
        return input
      }
    }
    return input
  }
  if (typeof nativeFetch === 'function' && globalThis.__DSH_FETCH_REWRITE__ !== true) {
    globalThis.__DSH_FETCH_REWRITE__ = true
    globalThis.fetch = (input, init) => nativeFetch(rewriteApiUrl(input), init)
  }

  // Download anchors (2026-09-18 H1 r2): upstream session-log-export hands
  // the UNREWRITTEN absolute URL to a DETACHED '<a download>' element and
  // calls .click() — detached clicks never propagate to document, so the r1
  // document-level capture listener could not see them, while its BLANKET
  // rewrite re-rooted the runtime selector's root-absolute anchors and broke
  // cross-world navigation (live-found 2026-09-18). Narrow seam: wrap
  // HTMLAnchorElement.prototype.click itself and rewrite ONLY anchors that
  // carry a 'download' attribute AND a same-authority root-absolute '/api'
  // href. Everything else — the runtime selector's links included — passes
  // through untouched.
  if (globalThis.HTMLAnchorElement !== undefined
    && globalThis.HTMLAnchorElement.prototype !== undefined
    && typeof globalThis.HTMLAnchorElement.prototype.click === 'function'
    && globalThis.__DSH_ANCHOR_CLICK_REWRITE__ !== true) {
    globalThis.__DSH_ANCHOR_CLICK_REWRITE__ = true
    const nativeAnchorClick = globalThis.HTMLAnchorElement.prototype.click
    globalThis.HTMLAnchorElement.prototype.click = function (...args) {
      try {
        if (this.hasAttribute('download')) {
          const current = this.getAttribute('href')
          if (typeof current === 'string' && current !== '') {
            const next = rewriteApiUrl(current)
            if (typeof next === 'string' && next !== current) this.setAttribute('href', next)
          }
        }
      } catch {
        /* best-effort: never break the click itself */
      }
      return nativeAnchorClick.apply(this, args)
    }
  }

  // Storage namespace (2026-09-16 storage findings P1): all worlds share one

  // origin, so bare localStorage keys would overwrite each other across
  // mounts. Prefix every key with the label; root '/' never injects this
  // shim and keeps bare keys. Never throws: attachPersistence only
  // console-errors on failure, so a throwing shim would silently disable
  // persistence.
  try {
  const StorageProto = globalThis.Storage && globalThis.Storage.prototype
  if (globalThis.localStorage !== undefined && StorageProto !== undefined
    && !globalThis.__DSH_STORAGE_NS__
    && typeof StorageProto.getItem === 'function'
    && typeof StorageProto.setItem === 'function'
    && typeof StorageProto.removeItem === 'function') {
    // NS derives from PREFIX, never LABEL: the mount HTML pass (index-pass)
    // rewrites every quoted root-absolute string EXCEPT "<label>/"-prefixed
    // ones, so the shim's LABEL="/omp" literal doubles to "/omp/omp" while
    // PREFIX="/omp/" is immune (live-found 2026-09-17, acceptance A2/A5).
    // The NS-from-PREFIX coupling is DELIBERATE: index-pass.ts rewrites double-quoted root-absolute strings except "<label>/"-prefixed ones, so LABEL="/omp" doubles while PREFIX="/omp/" survives; do NOT derive NS from LABEL.
    const NS = PREFIX.slice(1, -1) + ':'
    globalThis.__DSH_STORAGE_NS__ = NS
    const nativeGetItem = StorageProto.getItem
    const nativeSetItem = StorageProto.setItem
    const nativeRemoveItem = StorageProto.removeItem
    StorageProto.getItem = function (name) { return nativeGetItem.call(this, NS + name) }
    StorageProto.setItem = function (name, value) { return nativeSetItem.call(this, NS + name, value) }
    StorageProto.removeItem = function (name) { return nativeRemoveItem.call(this, NS + name) }
  }
  } catch {
    /* storage namespace is best-effort: never break the shim */
  }
})()`
}
