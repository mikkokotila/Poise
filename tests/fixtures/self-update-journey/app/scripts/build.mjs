// The fixture's release build. Like Poise's build-identity it refuses to stamp
// a requested SHA onto anything but a clean checkout at exactly that commit,
// then inlines the greeting module into one self-contained dist/server.js.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function buildSourceSha(expected = process.env.POISE_RELEASE_SHA) {
  let sha = null
  try {
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    const head = git('rev-parse', '--verify', 'HEAD')
    if (/^[0-9a-f]{40}$/.test(head) && !git('status', '--porcelain', '--untracked-files=normal')) sha = head
  } catch { /* not a checkout: a development build */ }
  if (expected && (!/^[0-9a-f]{40}$/.test(expected) || sha !== expected)) {
    throw new Error('Release build requires a clean checkout at the exact requested SHA')
  }
  return sha
}

const sha = buildSourceSha()
const greeting = readFileSync(join(root, 'src', 'greeting.mjs'), 'utf8').replace(/^export /gm, '')
const server = readFileSync(join(root, 'src', 'server.mjs'), 'utf8').replace(/^import \{[^}]*\} from '\.\/greeting\.mjs'\n/m, '')
if (server.includes('./greeting.mjs')) throw new Error('could not inline src/greeting.mjs')
const bundle = [
  '// Built by tests/fixtures/self-update-journey/app/scripts/build.mjs; do not edit.',
  `const __POISE_BUILD_SHA__ = ${JSON.stringify(sha)}`,
  greeting,
  server,
].join('\n')
mkdirSync(join(root, 'dist'), { recursive: true })
writeFileSync(join(root, 'dist', 'server.js'), bundle)
console.log(`[fixture] built dist/server.js for ${sha ?? 'development'}`)
