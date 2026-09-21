// Client mount shim (AW-B DL8): one head script rewrites every same-origin
// root-absolute URL under the mount — namespace-agnostic, idempotent, and
// covering the RPC fetch, the mux WebSocket, HMR EventSource, XHR uploads and
// the file-upload hook, and the per-world storage namespace.
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderClientShim } from '../dist/client-shim.js'

function fakeGlobal(extra = {}, labelPath = '/omp') {
  const calls = { fetch: [], ws: [], events: [], xhr: [] }
  const g = {
    location: { origin: 'http://host:4999', pathname: '/omp/' },
    calls,
    fetch: async (input, init) => { calls.fetch.push({ input: String(input), init }); return { ok: true } },
    WebSocket: class { static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3; constructor(url, protocols) { calls.ws.push({ url: String(url), protocols }) } },
    EventSource: class { static CONNECTING = 0; static OPEN = 1; static CLOSED = 2; constructor(url, options) { calls.events.push({ url: String(url), options }) } },
    XMLHttpRequest: class { open(method, url, ...rest) { calls.xhr.push({ method, url: String(url), rest }) } },
    ...extra,
  }
  new Function('globalThis', renderClientShim(labelPath))(g)
  return g
}

test('rewrite re-roots root-absolute paths, is idempotent, and leaves protocol-relative alone', () => {
  const g = fakeGlobal()
  const r = g.__DSH_TRANSPORT__.rewrite
  assert.equal(r('/api/session.list'), '/omp/api/session.list')
  assert.equal(r('/omp/api/session.list'), '/omp/api/session.list')
  assert.equal(r('//cdn.example/x.js'), '//cdn.example/x.js')
  assert.equal(r('./assets/a.js'), './assets/a.js')
  assert.equal(r('/'), '/omp/')
})

test('the transport fetch rewrites URL objects and delegates once', async () => {
  const g = fakeGlobal()
  await g.__DSH_TRANSPORT__.fetch(new URL('http://host:4999/api/session.list?x=1'))
  assert.deepEqual(g.calls.fetch, [{ input: 'http://host:4999/omp/api/session.list?x=1', init: undefined }])
})

test('the transport fetch leaves cross-origin requests untouched', async () => {
  const g = fakeGlobal()
  await g.__DSH_TRANSPORT__.fetch(new URL('http://other:1234/api/session.list'))
  assert.equal(g.calls.fetch[0].input, 'http://other:1234/api/session.list')
})

test('WebSocket, EventSource and XMLHttpRequest are re-rooted', () => {
  const g = fakeGlobal()
  new g.WebSocket('ws://host:4999/api/remote.mux')
  assert.equal(g.calls.ws[0].url, 'ws://host:4999/omp/api/remote.mux')
  new g.EventSource('/plugins/events')
  assert.equal(g.calls.events[0].url, '/omp/plugins/events')
  const xhr = new g.XMLHttpRequest()
  xhr.open('POST', '/api/session/uploadFileBinary?sessionId=s1')
  assert.equal(g.calls.xhr[0].url, '/omp/api/session/uploadFileBinary?sessionId=s1')
})

test('the intercepted constructors keep the native statics and prototype', () => {
  const g = fakeGlobal()
  // The upstream mux client compares socket.readyState against WebSocket.OPEN;
  // losing the static would leave every stream stuck at "connection lost".
  assert.equal(g.WebSocket.OPEN, 1)
  assert.equal(g.WebSocket.CONNECTING, 0)
  assert.equal(g.WebSocket.CLOSING, 2)
  assert.equal(g.WebSocket.CLOSED, 3)
  assert.equal(g.EventSource.OPEN, 1)
  assert.ok(g.WebSocket.prototype, 'prototype survives the interception')
  const socket = new g.WebSocket('/api/remote.mux')
  assert.ok(socket instanceof g.WebSocket, 'constructed sockets stay instances')
})

test('the file-upload hook is installed with the rewriting fetch', async () => {
  const g = fakeGlobal()
  assert.equal(typeof g.__DSH_FILE_UPLOAD__.fetch, 'function')
  await g.__DSH_FILE_UPLOAD__.fetch('/api/session/uploadFileBinary')
  assert.equal(g.calls.fetch[0].input, '/omp/api/session/uploadFileBinary')
})

test('a pre-existing transport (e.g. worker tunnel) is preserved and extended', () => {
  const g = fakeGlobal()
  const existing = { ownsHost: true }
  const g2 = fakeGlobal({ __DSH_TRANSPORT__: existing })
  assert.equal(g2.__DSH_TRANSPORT__.ownsHost, true)
  assert.equal(typeof g2.__DSH_TRANSPORT__.fetch, 'function')
  assert.equal(typeof g.__DSH_TRANSPORT__.fetch, 'function')
})

test('malformed mount roots are rejected', () => {
  assert.throws(() => renderClientShim('omp'), /labelPath must start with/)
  assert.throws(() => renderClientShim('/omp/'), /labelPath must start with/)
})

// ---- Storage namespace (2026-09-16 storage findings P1) ----
function storageFixture() {
  const backing = new Map()
  class StorageLike {
    getItem(k) { return backing.has(String(k)) ? backing.get(String(k)) : null }
    setItem(k, v) { backing.set(String(k), String(v)) }
    removeItem(k) { backing.delete(String(k)) }
    clear() { backing.clear() }
    key(i) { return [...backing.keys()][i] ?? null }
    get length() { return backing.size }
  }
  return { backing, StorageLike }
}

test('storage keys are namespaced per world and invisible across namespaces', () => {
  const { backing, StorageLike } = storageFixture()
  const g = fakeGlobal({ localStorage: new StorageLike(), Storage: StorageLike })
  const ls = g.localStorage
  ls.setItem('dsh.sessions.current', 'session-omp-1')
  assert.equal(backing.get('omp:dsh.sessions.current'), 'session-omp-1', 'physical key is prefixed')
  assert.equal(backing.has('dsh.sessions.current'), false, 'bare key never written')
  assert.equal(ls.getItem('dsh.sessions.current'), 'session-omp-1', 'wrapped read finds the prefixed key')
  ls.removeItem('dsh.sessions.current')
  assert.equal(backing.has('omp:dsh.sessions.current'), false, 'remove deletes the prefixed key only')
  assert.equal(g.__DSH_STORAGE_NS__, 'omp:')
})

test('the storage namespace derives from the mount root', () => {
  const { backing, StorageLike } = storageFixture()
  const g = fakeGlobal({ localStorage: new StorageLike(), Storage: StorageLike }, '/codex')
  g.localStorage.setItem('k', 'v')
  assert.equal(backing.get('codex:k'), 'v')
  assert.equal(g.__DSH_STORAGE_NS__, 'codex:')
})

test('the storage block stays inert and never throws without localStorage', () => {
  const g = fakeGlobal() // no localStorage / Storage on the fake global
  assert.equal(g.__DSH_STORAGE_NS__, undefined)
  assert.equal(typeof g.__DSH_TRANSPORT__.fetch, 'function', 'rest of the shim still installed')
})

test('re-running the shim does not double-wrap storage', () => {
  const { backing, StorageLike } = storageFixture()
  const g = fakeGlobal({ localStorage: new StorageLike(), Storage: StorageLike })
  new Function('globalThis', renderClientShim('/omp'))(g) // second execution, same global
  g.localStorage.setItem('k', 'v')
  assert.equal(backing.get('omp:k'), 'v')
  assert.equal(backing.has('omp:omp:k'), false)
})

test('clear, length and key() stay untouched', () => {
  const { StorageLike } = storageFixture()
  // Capture the pristine methods BEFORE the shim mutates the shared prototype
  // in place (post-shim, StorageLike.prototype.getItem IS the wrapper).
  const pristineGetItem = StorageLike.prototype.getItem
  const g = fakeGlobal({ localStorage: new StorageLike(), Storage: StorageLike })
  assert.equal(g.localStorage.clear, StorageLike.prototype.clear)
  assert.equal(g.localStorage.key, StorageLike.prototype.key)
  assert.equal(g.localStorage.length, 0, 'length untouched and functional')
  assert.notEqual(g.localStorage.getItem, pristineGetItem, 'the three carries ARE wrapped')
})

test('the storage NS survives the mount HTML pass (composition regression, live-found 2026-09-17)', async () => {
  // Real composition order: WorldWebServer.renderIndex injects the shim, THEN
  // rewriteIndexHtml rewrites quoted root-absolute strings — doubling the
  // shim's LABEL="/omp" literal (the pass excludes only "/omp/"-prefixed
  // strings). NS must come out single-prefixed and the transport rewrite must
  // still target the real mount root. If index-pass's real contract needs a
  // different html wrapper, adapt the wrapper — never the assertions.
  const { rewriteIndexHtml } = await import('../dist/index-pass.js')
  const page = rewriteIndexHtml(`<head><script>${renderClientShim('/omp')}</script></head>`, '/omp')
  const script = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1]
  assert.ok(script !== undefined, 'shim script still present after the mount pass')
  const { backing, StorageLike } = storageFixture()
  const g = { location: { origin: 'http://host:4999' }, fetch: async () => ({ ok: true }), localStorage: new StorageLike(), Storage: StorageLike }
  new Function('globalThis', script)(g)
  g.localStorage.setItem('k', 'v')
  assert.equal(g.__DSH_STORAGE_NS__, 'omp:', 'NS single-prefixed after the pass')
  assert.equal(backing.get('omp:k'), 'v')
  assert.equal(g.__DSH_TRANSPORT__.rewrite('/api/x'), '/omp/api/x', 'transport still re-roots to the real mount')
})

// ---- Global fetch wrapper + download-anchor rewrite (2026-09-17 H1 / 2026-09-18 r2) ----

function fakeAnchorElement() {
  const clicks = []
  class HTMLAnchorElement {
    constructor(href) {
      this.attrs = new Map(href === undefined ? [] : [['href', href]])
    }
    hasAttribute(name) { return this.attrs.has(name) }
    getAttribute(name) { return this.attrs.get(name) ?? null }
    setAttribute(name, value) { this.attrs.set(name, String(value)) }
    click(...args) { clicks.push({ href: this.getAttribute('href'), args }) }
  }
  return { HTMLAnchorElement, clicks }
}

test('the global fetch rewrites absolute ctx0-root /api URLs and preserves the query', async () => {
  const g = fakeGlobal()
  await g.fetch(new URL('http://host:4999/api/session.export?sessionId=s1&includeDescendants=true'), { method: 'HEAD' })
  assert.equal(g.calls.fetch[0].input, 'http://host:4999/omp/api/session.export?sessionId=s1&includeDescendants=true')
  assert.equal(g.calls.fetch[0].init.method, 'HEAD')
  await g.fetch('/api/x?y=1#frag')
  assert.equal(g.calls.fetch[1].input, '/omp/api/x?y=1#frag', 'root-absolute strings rewrite too')
})

test('the global fetch leaves non-/api, same-mount, relative, and foreign URLs untouched', async () => {
  const g = fakeGlobal()
  await g.fetch(new URL('http://host:4999/plugins/thing'))
  await g.fetch(new URL('http://host:4999/omp/api/session.list'))
  await g.fetch('./assets/a.js')
  await g.fetch(new URL('http://other:1234/api/x'))
  assert.equal(g.calls.fetch[0].input, 'http://host:4999/plugins/thing')
  assert.equal(g.calls.fetch[1].input, 'http://host:4999/omp/api/session.list')
  assert.equal(g.calls.fetch[2].input, './assets/a.js')
  assert.equal(g.calls.fetch[3].input, 'http://other:1234/api/x')
})

test('the global fetch rewrite survives the mount HTML pass (single-quote contract)', async () => {
  // index-pass rewrites every DOUBLE-quoted root-absolute string in the served
  // HTML; the shim's '/api' literals must stay single-quoted or this rewrite
  // silently dies after the pass.
  const { rewriteIndexHtml } = await import('../dist/index-pass.js')
  const page = rewriteIndexHtml(`<head><script>${renderClientShim('/omp')}</script></head>`, '/omp')
  const script = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1]
  assert.ok(script !== undefined, 'shim script still present after the mount pass')
  const calls = []
  const g = {
    location: { origin: 'http://host:4999' },
    fetch: async (input) => { calls.push(String(input)); return { ok: true } },
  }
  new Function('globalThis', script)(g)
  await g.fetch(new URL('http://host:4999/api/session.export?sessionId=s1&includeDescendants=true'), { method: 'HEAD' })
  assert.equal(calls[0], 'http://host:4999/omp/api/session.export?sessionId=s1&includeDescendants=true')
})

test('a detached download anchor with an /api href is re-rooted before the click', () => {
  // The live-found bug (2026-09-18): upstream downloadUrl() creates a DETACHED
  // anchor and clicks it — document-level listeners never fire. The seam must
  // be the prototype method itself.
  const { HTMLAnchorElement, clicks } = fakeAnchorElement()
  fakeGlobal({ HTMLAnchorElement })
  const anchor = new HTMLAnchorElement('http://host:4999/api/session.export?sessionId=s1&includeDescendants=true')
  anchor.setAttribute('download', 'session-log.zip')
  anchor.click()
  assert.equal(anchor.getAttribute('href'), 'http://host:4999/omp/api/session.export?sessionId=s1&includeDescendants=true')
  assert.equal(clicks[0].href, anchor.getAttribute('href'), 'native click sees the rewritten href')
})

test('root-absolute /api download hrefs rewrite; foreign and non-api stay virgin', () => {
  const { HTMLAnchorElement } = fakeAnchorElement()
  fakeGlobal({ HTMLAnchorElement })
  const rel = new HTMLAnchorElement('/api/session.export?x=1')
  rel.setAttribute('download', 's.zip')
  rel.click()
  assert.equal(rel.getAttribute('href'), '/omp/api/session.export?x=1')
  const foreign = new HTMLAnchorElement('http://other:1234/api/x')
  foreign.setAttribute('download', 's.zip')
  foreign.click()
  assert.equal(foreign.getAttribute('href'), 'http://other:1234/api/x', 'foreign authority untouched')
  const plugins = new HTMLAnchorElement('/plugins/thing')
  plugins.setAttribute('download', 's.zip')
  plugins.click()
  assert.equal(plugins.getAttribute('href'), '/plugins/thing', 'non-/api paths untouched')
})

test('selector-style anchors (no download attribute) are never touched', () => {
  // Live-found regression (2026-09-18): the r1 blanket document listener
  // re-rooted the runtime selector's /<label>/ anchors (RuntimeSeat.tsx <a
  // href="/omp/">) into /<current-label>/omp/ and broke cross-world
  // navigation. The r2 seam must leave every non-download anchor virgin.
  const { HTMLAnchorElement, clicks } = fakeAnchorElement()
  fakeGlobal({ HTMLAnchorElement })
  const omp = new HTMLAnchorElement('/omp/')
  omp.click()
  const native = new HTMLAnchorElement('/')
  native.click()
  const other = new HTMLAnchorElement('/codex/')
  other.click()
  assert.equal(omp.getAttribute('href'), '/omp/')
  assert.equal(native.getAttribute('href'), '/')
  assert.equal(other.getAttribute('href'), '/codex/')
  assert.deepEqual(clicks.map((c) => c.href), ['/omp/', '/', '/codex/'], 'clicks dispatch with virgin hrefs')
})

test('an /api href WITHOUT a download attribute is not rewritten', () => {
  const { HTMLAnchorElement } = fakeAnchorElement()
  fakeGlobal({ HTMLAnchorElement })
  const nav = new HTMLAnchorElement('/api/session.export?x=1')
  nav.click()
  assert.equal(nav.getAttribute('href'), '/api/session.export?x=1')
})

test('re-running the shim neither double-wraps fetch nor the anchor click', () => {
  const { HTMLAnchorElement } = fakeAnchorElement()
  const g = fakeGlobal({ HTMLAnchorElement })
  const wrappedFetch = g.fetch
  const wrappedClick = HTMLAnchorElement.prototype.click
  new Function('globalThis', renderClientShim('/omp'))(g)
  assert.equal(g.fetch, wrappedFetch)
  assert.equal(HTMLAnchorElement.prototype.click, wrappedClick)
})

test('the anchor rewrite survives the mount HTML pass (single-quote contract)', async () => {
  const { rewriteIndexHtml } = await import('../dist/index-pass.js')
  const page = rewriteIndexHtml(`<head><script>${renderClientShim('/omp')}</script></head>`, '/omp')
  const script = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1]
  assert.ok(script !== undefined, 'shim script still present after the mount pass')
  const { HTMLAnchorElement } = fakeAnchorElement()
  const g = { location: { origin: 'http://host:4999' }, HTMLAnchorElement }
  new Function('globalThis', script)(g)
  const anchor = new HTMLAnchorElement('/api/session.export?sessionId=s1')
  anchor.setAttribute('download', 's.zip')
  anchor.click()
  assert.equal(anchor.getAttribute('href'), '/omp/api/session.export?sessionId=s1')
})
