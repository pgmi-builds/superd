// Client-half build for the super-dsh PACKAGE face: same closure-factory
// recipe as agent-hub/scripts/build-client.mjs, but the registration id is
// the SUPER-DSH package name — the browser module loader pairs registrations
// with graph rows by this baked id (pendingQueue match), and the graph row's
// id is the manifest package name of the composed bundle. When super-dsh is
// the composed package, the bundle must register as "super-dsh" (the hub's
// own lib/client with id "@pgmi-builds/agent-hub" is for the dev line where
// the hub itself is the bundle). Run: npm run build-client:superd
import { build } from 'tsdown'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ID = 'super-dsh'
const hubRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(hubRoot, '..', 'client')
const OUT_FILE = 'index.js'

// The loader-table entries the bundle may require at runtime; everything
// else inlines. Type-only peers stay type-only (purity gate below).
const CLIENT_EXTERNALS = [
  'react',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-store',
]

mkdirSync(outDir, { recursive: true })

await build({
  config: false,
  name: `${ID}/client`,
  entry: { index: join(hubRoot, 'src/client/index.ts') },
  outDir,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  clean: false,
  external: [...CLIENT_EXTERNALS],
  noExternal: (id) => !CLIENT_EXTERNALS.includes(id),
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  outputOptions: {
    entryFileNames: OUT_FILE,
    // Closure-factory handoff (mirror of the dsh tsdown recipe).
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
  plugins: [
    {
      name: 'dsh-client-bundle-purity',
      resolveId(source) {
        if (source.startsWith('@deepseek-ai/') && !CLIENT_EXTERNALS.includes(source)) {
          throw new Error(
            `client bundle purity: value import of ${source} is not in CLIENT_EXTERNALS — type-only peers must stay type-only (use \`import type\`)`,
          )
        }
        return null
      },
    },
  ],
})

const outFile = join(outDir, OUT_FILE)
if (!existsSync(outFile)) {
  throw new Error(`client build did not produce ${outFile}`)
}
console.log(`build-client:superd: agent-hub/src/client/index.ts -> super-dsh/client/${OUT_FILE} (closure-factory CJS, id=${ID})`)
