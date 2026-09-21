// Mount HTML pass (AW-B DL8 server half): the world dist keeps relative asset
// URLs, so `<base>` is pinned at the mount; root-absolute strings (boot graph
// `/plugins/...`, injected sources, href="/") are re-rooted by one generic
// rule — no namespace enumeration, and idempotent.
import test from 'node:test'
import assert from 'node:assert/strict'
import { rewriteIndexHtml } from '../dist/carrier.js'

test('pins the base at the mount and re-roots root-absolute strings', () => {
  const html = '<head><base href="/"></head><script>globalThis.__DSH_BOOT__={"batches":[{"url":"/plugins/??a/client.js&rev=1"}]}</script>'
  const out = rewriteIndexHtml(html, '/omp')
  assert.match(out, /<base href="\/omp\/">/)
  assert.match(out, /"url":"\/omp\/plugins\/\?\?a\/client\.js&rev=1"/)
})

test('inserts a base after <head> when the dist has none', () => {
  const out = rewriteIndexHtml('<html><head><link rel="icon" href="./favicon.svg"></head><body></body></html>', '/omp')
  assert.match(out, /<head><base href="\/omp\/">/)
  assert.match(out, /href="\.\/favicon\.svg"/, 'relative assets stay relative')
})

test('leaves protocol-relative and already-mounted URLs alone; is idempotent', () => {
  const html = '<head></head><script>"//cdn.example/x" "/omp/plugins/a.js" "/api/session.list"</script>'
  const once = rewriteIndexHtml(html, '/omp')
  assert.match(once, /"\/\/cdn\.example\/x"/)
  assert.match(once, /"\/omp\/plugins\/a\.js"/)
  assert.match(once, /"\/omp\/api\/session\.list"/)
  assert.equal(rewriteIndexHtml(once, '/omp'), once)
})

test('rejects a malformed mount root', () => {
  assert.throws(() => rewriteIndexHtml('<head></head>', 'omp'), /labelPath must start with/)
  assert.throws(() => rewriteIndexHtml('<head></head>', '/omp/'), /labelPath must start with/)
})
