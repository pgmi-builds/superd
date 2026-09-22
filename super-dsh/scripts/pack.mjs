// super-dsh pack orchestrator — THE build entry (docs/06 §三 discipline).
// Builds every component and produces the single delivery tarball:
//
//   node super-dsh/scripts/pack.mjs [--keep-going]
//
// The dev 4999 line and the npm release consume the SAME artifact from here;
// nothing else may hand-assemble super-dsh dists or tarballs.
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const LINE = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = dirname(LINE)
const PACK_DIR = join(REPO, '.scratch/aw-pack')

const run = (cmd, cwd) => execSync(cmd, {
  cwd,
  stdio: 'inherit',
  // claude-agent-sdk + zod 4 types blow the default heap under tsc.
  env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=8192`.trim() },
})

console.log('[pack] building agent-hub (tsc + client halves)')
run('npm run build', join(LINE, 'agent-hub'))
run('npm run build-client', join(LINE, 'agent-hub'))
run('node scripts/build-superd-client.mjs', join(LINE, 'agent-hub'))

for (const pkg of ['agent-omp', 'agent-codex', 'agent-claude', 'agent-pi', 'agent-hermes', 'agent-agy']) {
  console.log(`[pack] building ${pkg} (tsc)`)
  run('npm run build', join(LINE, pkg))
}

const { version } = JSON.parse(readFileSync(join(LINE, 'package.json'), 'utf8'))
console.log(`[pack] npm pack super-dsh@${version}`)
run(`mkdir -p ${PACK_DIR}`, REPO)
run(`npm pack --pack-destination ${PACK_DIR}`, LINE)
console.log(`[pack] tarball: ${PACK_DIR}/super-dsh-${version}.tgz`)
