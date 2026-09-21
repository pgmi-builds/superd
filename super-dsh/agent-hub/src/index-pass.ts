/**
 * Mount HTML pass (AW-B DL1/DL8 server half).
 *
 * The world dist is built with RELATIVE asset URLs (`./assets/...`), so a
 * `<base>` pointing at the mount makes every relative reference resolve under
 * `/<label>/`. Root-absolute strings (the boot graph's `/plugins/...` URLs,
 * injected script sources, `href="/"`-style anchors) do NOT follow `<base>`,
 * so they are re-rooted explicitly — one generic rule, no namespace list.
 */

/** Root of the mount including the trailing slash (`/omp` → `/omp/`). */
function mountPrefix(labelPath: string): string {
  return labelPath.endsWith('/') ? labelPath : `${labelPath}/`
}

/**
 * Rewrite a world index for serving under `<labelPath>/`.
 *
 * - pins `<base>` at the mount (inserting one after `<head>` when absent);
 * - prefixes every double-quoted root-absolute string that is not already
 *   mounted and not protocol-relative (`//host/...`);
 * - idempotent (a second pass changes nothing).
 *
 * @param html - the world's index.html (already rendered with its own rows).
 * @param labelPath - mount root, e.g. `/omp`.
 * @returns the mount-ready HTML.
 */
export function rewriteIndexHtml(html: string, labelPath: string): string {
  if (typeof labelPath !== 'string' || !labelPath.startsWith('/') || labelPath === '/' || labelPath.endsWith('/')) {
    throw new Error(`index-pass: labelPath must start with "/" and carry no trailing slash, got ${JSON.stringify(labelPath)}`)
  }
  const prefix = mountPrefix(labelPath)
  let out = html
  if (/<base\b[^>]*>/i.test(out)) {
    out = out.replace(/<base\b[^>]*>/i, `<base href="${prefix}">`)
  } else if (/<head(?:\s[^>]*)?>/i.test(out)) {
    out = out.replace(/<head(?:\s[^>]*)?>/i, open => `${open}<base href="${prefix}">`)
  }
  out = out.replace(/"(\/[^"]*)"/g, (whole: string, path: string) => {
    if (path.startsWith('//')) return whole
    // Load-bearing contract: client-shim.ts derives its storage NS from the surviving "<label>/" literal (regression test: the storage NS survives the mount HTML pass). Changing this exclusion breaks that coupling.
    if (path.startsWith(prefix)) return whole
    return `"${prefix}${path.slice(1)}"`
  })
  return out
}
