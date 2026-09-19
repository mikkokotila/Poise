import { describe, expect, it } from 'vitest'
import { describeViolations, evaluatePolicy, reviewPolicy } from '../scripts/self-update/policy.mjs'

const file = (path, overrides = {}) => ({ status: 'M', oldMode: '100644', newMode: '100644', path, ...overrides })
const texts = (before, after) => async side => side === 'base' ? before : after

describe('Poise-only delegated change policy', () => {
  it('allows ordinary frontend, backend, scripts, documents and dependency locks', () => {
    for (const path of ['src/views/chat.ts', 'server/editor.ts', 'server/chat/adapters/muse.ts', 'scripts/export-fixture.mjs', 'package-lock.json', 'LICENSE', 'README.md', 'SECURITY.md', '.gitignore', '.github/ISSUE_TEMPLATE/bug.md', 'tests/chat/runtime.test.ts']) {
      expect(evaluatePolicy([file(path)]), path).toEqual({ allowed: true, violations: [] })
    }
  })
  it('has no arbitrary changed-file count or frontend directory limit', () => {
    expect(evaluatePolicy(Array.from({ length: 501 }, (_, n) => file(`server/generated-${n}.ts`))).allowed).toBe(true)
  })
  it('rejects an empty diff', () => {
    expect(evaluatePolicy([]).allowed).toBe(false)
    expect(evaluatePolicy(null).violations[0].reason).toBe('no changed files')
  })
  it.each([
    'server/http.ts', 'scripts/self-update/policy.mjs', 'config/caller-release.json',
    '.github/workflows/ci.yml', 'server/self-update.ts', 'src/self-update-reload.ts',
    'src/build-identity.ts', 'src/poise-request-intent.ts', 'tests/self-update-controller.test.mjs',
    'tests/http.test.ts', 'tests/claude-auth.test.ts', 'scripts/install-production.mjs',
    '.env.local', 'src/.npmrc', 'keys/private.pem', 'docs/.gitmodules',
  ])('keeps the agreed release/authorization/credential boundary: %s', path => {
    expect(evaluatePolicy([file(path)]).allowed, path).toBe(false)
  })
  it('rejects malformed paths and case-folded protection bypasses, not ordinary capitalized files', () => {
    for (const path of ['../x', 'src/../x', '/etc/passwd', 'src/a\nb.ts', ' src/a.ts', 'src//a.ts', 'src/./a.ts', 'Src/Self-Update-types.ts']) {
      expect(evaluatePolicy([file(path)]).allowed, path).toBe(false)
    }
    expect(evaluatePolicy([file('SRC/ordinary.ts')]).allowed).toBe(true)
  })
  it('checks both sides of renames and does not expand authority to a submodule', () => {
    expect(evaluatePolicy([file('src/new.ts', { status: 'R', oldPath: 'scripts/self-update/policy.mjs' })]).allowed).toBe(false)
    expect(evaluatePolicy([file('src/new.ts', { status: 'R', oldPath: 'server/old.ts' })]).allowed).toBe(true)
    expect(evaluatePolicy([file('src/vendor', { newMode: '160000' })]).allowed).toBe(false)
    expect(evaluatePolicy([file('src/a.ts', { status: 'U' })]).allowed).toBe(false)
  })
  it('allows ordinary dependencies and scripts while preserving the validation and publication commands', async () => {
    const before = { repository: { url: 'https://github.com/mikkokotila/Poise.git' }, scripts: { check: 'npm test', build: 'vite build', 'self-update:enable': 'node trusted.mjs' }, dependencies: { ws: '1' } }
    const after = { ...before, scripts: { ...before.scripts, format: 'prettier src' }, dependencies: { ws: '2', yaml: '1' } }
    expect((await reviewPolicy([file('package.json')], texts(JSON.stringify(before), JSON.stringify(after)))).allowed).toBe(true)
    for (const script of ['check', 'precheck', 'build', 'postinstall', 'self-update:enable', 'update:caller']) {
      const changed = { ...before, scripts: { ...before.scripts, [script]: 'echo bypass' } }
      expect((await reviewPolicy([file('package.json')], texts(JSON.stringify(before), JSON.stringify(changed)))).allowed, script).toBe(false)
    }
    expect((await reviewPolicy([file('package.json')], texts(JSON.stringify(before), '{invalid'))).allowed).toBe(false)
    expect((await reviewPolicy([file('vitest.config.ts')], texts('', ''))).allowed).toBe(false)
  })
  it('permits additive schema work but not destructive migration statements', async () => {
    expect((await reviewPolicy([file('server/db.ts')], texts('', 'db.exec(`CREATE TABLE things (id INTEGER)`);'))).allowed).toBe(true)
    for (const sql of ['DROP TABLE chat_sessions', 'ALTER TABLE meta DROP COLUMN value', 'DELETE FROM meta', 'UPDATE meta SET value = 0']) {
      expect((await reviewPolicy([file('server/db.ts')], texts('', `db.exec(${JSON.stringify(sql)})`))).allowed, sql).toBe(false)
    }
  })
  it('allows internal symlinks but refuses escape and protected targets', async () => {
    const entry = file('src/link', { newMode: '120000', oldMode: '000000', status: 'A' })
    expect((await reviewPolicy([entry], texts(null, 'ordinary.ts'))).allowed).toBe(true)
    for (const target of ['/etc/passwd', '../../other/x', '../server/http.ts']) expect((await reviewPolicy([entry], texts(null, target))).allowed, target).toBe(false)
  })
  it('reports all violations without flooding the interface', () => {
    const verdict = evaluatePolicy(Array.from({ length: 20 }, (_, n) => file(`scripts/self-update/${n}.mjs`)))
    expect(verdict.violations).toHaveLength(20)
    expect(describeViolations(verdict.violations)).toContain('and 8 more')
  })
})
