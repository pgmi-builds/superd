// Virtual per-world webServer (AW-B DL3): ANY prefix a world plugin declares
// is translated at REGISTRATION time into `/<label> + path`, and the plugin's
// handler sees the world-relative URL again. No namespace enumeration, no
// cross-world collisions, world index rows stay world-local.
import test from 'node:test'
import assert from 'node:assert/strict'
import { WorldWebServer } from '../dist/world-web-server.js'

function fakeReal() {
  return {
    routes: new Map(),
    upgrades: new Map(),
    fallback: undefined,
    taps: [],
    register(route) {
      const id = `${route.kind}:${route.path}`
      if (this.routes.has(id)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
      this.routes.set(id, route)
      return () => this.routes.delete(id)
    },
    registerUpgrade(route) {
      if (this.upgrades.has(route.path)) throw new Error(`webserver: duplicate upgrade route "${route.path}"`)
      this.upgrades.set(route.path, route)
      return () => this.upgrades.delete(route.path)
    },
    registerFallback(handler) { this.fallback = handler; return () => { this.fallback = undefined } },
    tapIndex(t) { this.taps.push(t); return () => { } },
    port: 4999,
    host: '127.0.0.1',
  }
}

function req(url) { return { url } }
function res() { return { status: 200, writableEnded: false, end() { this.writableEnded = true } } }

test('register translates ANY declared prefix and strips the label for the plugin handler', async () => {
  const real = fakeReal()
  const world = new WorldWebServer('/omp', real)
  const seen = []
  world.register({ kind: 'prefix', path: '/fuck-you-name-i-like', handler: (r) => seen.push(r.url) })
  assert.equal(real.routes.has('prefix:/omp/fuck-you-name-i-like'), true)
  await real.routes.get('prefix:/omp/fuck-you-name-i-like').handler(req('/omp/fuck-you-name-i-like/x?q=1'))
  assert.deepEqual(seen, ['/fuck-you-name-i-like/x?q=1'])
})

test('register keeps query strings and maps the bare mount path to /', async () => {
  const real = fakeReal()
  const world = new WorldWebServer('/omp', real)
  const seen = []
  world.register({ kind: 'prefix', path: '/rpc', handler: (r) => seen.push(r.url) })
  const handler = real.routes.get('prefix:/omp/rpc').handler
  await handler(req('/omp/rpc/session.list?a=1'))
  await handler(req('/omp/rpc'))
  await handler(req('/omp/rpc?b=2'))
  assert.deepEqual(seen, ['/rpc/session.list?a=1', '/rpc', '/rpc?b=2'])
})

test('registerUpgrade translates exact paths (upgrades have no prefix semantics)', () => {
  const real = fakeReal()
  const world = new WorldWebServer('/omp', real)
  world.registerUpgrade({ path: '/rpc/stream', handler: () => { } })
  assert.equal(real.upgrades.has('/omp/rpc/stream'), true)
  assert.equal(real.upgrades.has('/omp/stream'), false)
})

test('registerFallback claims the mount prefix and strips the label before the world fallback', async () => {
  const real = fakeReal()
  const world = new WorldWebServer('/omp', real)
  const seen = []
  world.registerFallback((r) => seen.push(r.url))
  assert.equal(real.routes.has('prefix:/omp'), true)
  await real.routes.get('prefix:/omp').handler(req('/omp/assets/index.js'))
  assert.deepEqual(seen, ['/assets/index.js'])
})

test('index taps and injections stay world-local and render through the mount', () => {
  const real = fakeReal()
  const rows = []
  const world = new WorldWebServer('/omp', real, { onIndexInject: (table) => table.push({ kind: 'script', placement: 'head', text: 'x' }) })
  world.tapIndex((html) => html.replace('</head>', '<meta name="tapped"></head>'))
  world.registerFallback(() => { })
  const out = world.renderIndex('<head></head>')
  assert.match(out, /<meta name="tapped">/)
  assert.match(out, /<script>x<\/script>/)
})

test('dispose releases every translated registration', () => {
  const real = fakeReal()
  const world = new WorldWebServer('/omp', real)
  world.register({ kind: 'prefix', path: '/rpc', handler: () => { } })
  world.registerUpgrade({ path: '/rpc/stream', handler: () => { } })
  world.registerFallback(() => { })
  world.dispose()
  assert.equal(real.routes.size, 0)
  assert.equal(real.upgrades.size, 0)
  assert.equal(real.fallback, undefined)
})

test('labelPath must be a rooted segment', () => {
  const real = fakeReal()
  assert.throws(() => new WorldWebServer('omp', real), /labelPath must start with/)
})

test('hub-owned RPC paths are swallowed: the hub answers /<label>/api with ctx0 auth', () => {
  const real = fakeReal()
  const world = new WorldWebServer('/omp', real)
  const apiDispose = world.register({ kind: 'prefix', path: '/api', handler: () => {} })
  const muxDispose = world.registerUpgrade({ path: '/api/remote.mux', handler: () => {} })
  assert.equal(real.routes.size, 0, 'no /omp/api translation from the world')
  assert.equal(real.upgrades.size, 0, 'no /omp/api/remote.mux translation from the world')
  assert.equal(typeof apiDispose, 'function')
  apiDispose()
  muxDispose()
  // Other prefixes still translate normally.
  world.register({ kind: 'prefix', path: '/plugins', handler: () => {} })
  assert.equal(real.routes.has('prefix:/omp/plugins'), true)
})

test('renderIndex emits a mount-ready page (base pinned, root-absolute strings re-rooted)', () => {
  const real = fakeReal()
  const world = new WorldWebServer('/omp', real, { onIndexInject: (table) => table.push({ kind: 'script', placement: 'head', text: 'x' }) })
  const out = world.renderIndex('<head><base href="/"></head><script>globalThis.__DSH_BOOT__={"batches":[{"url":"/plugins/??a/client.js"}]}</script>')
  assert.match(out, /<base href="\/omp\/">/)
  assert.match(out, /"url":"\/omp\/plugins\/\?\?a\/client\.js"/)
  assert.match(out, /<script>x<\/script>/)
})

test('renderIndex injects the client mount shim as the first head row', () => {
  const real = fakeReal()
  const world = new WorldWebServer('/omp', real)
  const out = world.renderIndex('<head></head>')
  assert.match(out, /__DSH_TRANSPORT__/)
  assert.match(out, /__DSH_FILE_UPLOAD__/)
  assert.ok(out.indexOf('__DSH_TRANSPORT__') < out.indexOf('</head>'), 'shim runs before the app entry')
})

test('the served fallback HTML is fixed up: the first <base> (added downstream) becomes the mount', async () => {
  const real = fakeReal()
  const world = new WorldWebServer('/omp', real)
  // The world's frontend-static injects <base href="/"> AFTER renderIndex, so
  // the first base tag on the wire is upstream's until this pass fixes it.
  world.registerFallback((_req, res) => {
    res.end('<head><base href="/"></head><script>"\/plugins\/a.js"</script>')
  })
  const sent = []
  const res = { end: (chunk) => { sent.push(String(chunk)) } }
  await real.routes.get('prefix:/omp').handler(req('/omp/'), res)
  // The mount base must be the FIRST base in the document…
  assert.equal(sent[0].match(/<base href="([^"]*)"/)?.[1], '/omp/')
  assert.match(sent[0], /"\/omp\/plugins\/a\.js"/)
  // …and the agent roster rides this same outbound pass, AFTER the mount
  // rewrite, so other worlds' paths survive untouched.
  assert.match(sent[0], /__DSH_AGENT_ROSTER__/)
  assert.match(sent[0], /"path":"\/"/)
})
