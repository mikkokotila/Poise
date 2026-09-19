// Automatic tool permissions for the one authorized turn of a Poise change.
//
// The person delegated an ordinary Poise improvement once; the native agent
// (Claude, Muse, Codex or Grok) then asks the runtime to allow every file
// edit and shell command as it would in any session. Inside an active
// change turn those requests are answered here, without a click, whenever
// they stay within the delegated work: reading and editing files in the
// prepared checkout, and the local development commands the runbook asks
// for (npm ci, npm run check/test/build, vitest/playwright/eslint/tsc,
// git status/diff/log/add/commit on the bound branch). Anything else —
// another directory or repository, credentials, network side effects,
// push/merge/reset/checkout/rebase/restart, shell constructs that cannot be
// read — is rejected with a reason the agent and the person both see. An
// unrecognised request is a rejection too, never a prompt: the person is
// not asked to confirm what they already delegated, and the agent has the
// ordinary local tools for everything the delegation covers.
//
// This is a policy over the request the agent sent, not an OS sandbox. npm
// scripts and test code in the checkout are trusted local code, and the
// release controller validates the exact resulting change and hardcodes the
// repository on its own. Nothing here hands the agent a release token or a
// session-wide grant: every allow is `allow_once`, decided per request from
// the path and command fields the adapter put on the request.

import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, normalize, resolve } from 'node:path'
import type { PermissionRequest } from './chat/adapters/types'

export interface SelfChangeScope {
  /** Canonical absolute path of the prepared checkout (symlinks resolved). */
  workspace: string
  /** The branch the checkout is bound to; informational in reasons. */
  branch: string
  /** Resolves a path through the file system's symlinks (the deepest
   *  existing ancestor's realpath plus the rest). Defaults to the real
   *  file system; tests inject their own. */
  realpath?: (path: string) => string
}

export type SelfChangeAllowClassification = 'workspace_file' | 'workspace_command'

export type SelfChangeRejectClassification =
  | 'outside_workspace'      // a path, cwd or checkout other than the prepared one
  | 'protected_path'         // git internals or a write Muse marks protected
  | 'credentials'            // .env files, keychain, gh/npm login, signing
  | 'network'                // fetch/curl/wget/ssh, registry fetches beyond npm ci, Codex network grants
  | 'release_control'        // push/merge/PR/deploy/restart, branch/history changes
  | 'interactive'            // editors, watchers, servers, stdin to a running command
  | 'shell_construct'        // expansions, subshells, background jobs, env overrides
  | 'unrecognised_command'   // a program outside the local development toolset
  | 'unrecognised_request'   // no command or path field to check
  | 'no_once_option'         // the agent offered no allow-once option

export type SelfChangeToolDecision =
  | { verdict: 'allow', optionId: string, classification: SelfChangeAllowClassification, reason: string, evidence: string[] }
  | { verdict: 'reject', optionId: string | null, classification: SelfChangeRejectClassification, reason: string, evidence: string[] }

type Access = 'read' | 'write'

type Refusal = { ok: false, classification: SelfChangeRejectClassification, reason: string }
type Checked = { ok: true, evidence: string[] } | Refusal

const ok = (evidence: string[] = []): Checked => ({ ok: true, evidence })
const refuse = (classification: SelfChangeRejectClassification, reason: string): Refusal => ({ ok: false, classification, reason })

// ── Public entry points ────────────────────────────────────────────────────

/** Decide one native permission request inside an active change turn. */
export function decideSelfChangePermission(request: PermissionRequest, scope: SelfChangeScope): SelfChangeToolDecision {
  const checked = classify(request, scope)
  if (checked.ok) {
    const once = request.options.find((option) => option.kind === 'allow_once')
    if (!once) {
      return finish(request, refuse('no_once_option', 'the agent offered no once-only allow option for this request; Poise never grants a session-wide permission on the person\'s behalf'), checked.evidence)
    }
    return { verdict: 'allow', optionId: once.id, classification: checked.classification, reason: checked.reason, evidence: checked.evidence }
  }
  return finish(request, checked, checked.evidence ?? [])
}

/** The environment a change agent (and every command it runs) inherits.
 *  Removes the running instance's release identity and runtime
 *  configuration — the release root/sha/id, the controller bridge, the
 *  database, ports and directories of the production server — and an
 *  inherited `NODE_ENV=production` or npm production flags, so `npm ci
 *  --include=dev`, `npm run check` and the build act on the checkout with
 *  its own defaults. Provider credentials are neither added nor removed:
 *  that isolation is decided where the agent is spawned. */
export function changeAgentEnvironment(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue
    const upper = key.toUpperCase()
    if (upper.startsWith('POISE_')) continue
    if (upper.startsWith('NPM_') || upper === 'INIT_CWD') continue
    if (upper === 'NODE_ENV' && value.trim().toLowerCase() === 'production') continue
    env[key] = value
  }
  return env
}

// ── Classification of the request ───────────────────────────────────────────

type Classified = ({ ok: true, classification: SelfChangeAllowClassification, reason: string, evidence: string[] }) | (Refusal & { evidence?: string[] })

function finish(request: PermissionRequest, refusal: Refusal, evidence: string[]): SelfChangeToolDecision {
  const once = request.options.find((option) => option.kind === 'reject_once') ?? request.options.find((option) => option.kind === 'reject_always')
  return { verdict: 'reject', optionId: once?.id ?? null, classification: refusal.classification, reason: refusal.reason, evidence }
}

function classify(request: PermissionRequest, scope: SelfChangeScope): Classified {
  const input = request.input
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return refuse('unrecognised_request', `the request "${request.title}" carries no tool input to check; use the ordinary file and shell tools inside ${scope.workspace}`)
  }
  const fields = input as Record<string, unknown>

  // Muse: { tool, args, subject, protectedWrite }
  if (fields.subject && typeof fields.subject === 'object' && typeof (fields.subject as any).kind === 'string') {
    return classifyMuse(fields, scope)
  }
  // Codex permission profile: { cwd, permissions }
  if (fields.permissions && typeof fields.permissions === 'object') {
    return classifyCodexPermissions(fields, scope)
  }
  // Codex file change: { grantRoot }
  if ('grantRoot' in fields && !('command' in fields)) {
    if (typeof fields.grantRoot !== 'string') {
      return refuse('unrecognised_request', `the file change names no path to check; apply edits under ${scope.workspace} with the ordinary editing tools, which need no approval there`)
    }
    const path = checkPath(fields.grantRoot, scope.workspace, scope, 'write')
    if (!path.ok) return path
    return { ok: true, classification: 'workspace_file', reason: `writes under ${path.evidence[0]} stay inside the prepared checkout`, evidence: path.evidence }
  }
  // Codex command: { command, cwd, kind, actions, network }
  if ('kind' in fields && 'command' in fields) {
    if (fields.kind === 'writeStdin') {
      return refuse('interactive', 'input to a running command cannot be checked; run commands non-interactively instead')
    }
    if (fields.network && typeof fields.network === 'object') {
      const network = fields.network as { host?: unknown, protocol?: unknown }
      const command = typeof fields.command === 'string' ? fields.command : ''
      if (!(isRegistryHost(network.host) && network.protocol === 'https' && isPackageInstall(command))) {
        return refuse('network', `network access to ${String(network.host ?? 'an unnamed host')} is outside the delegated work; only npm's registry fetch for installing the checkout's dependencies is expected`)
      }
    }
  }

  return classifyGeneric(fields, scope)
}

function classifyMuse(fields: Record<string, unknown>, scope: SelfChangeScope): Classified {
  const subject = fields.subject as { kind: string, command?: unknown, path?: unknown, access?: unknown, host?: unknown, target?: unknown, workspaceRoot?: unknown }
  const args = fields.args && typeof fields.args === 'object' ? fields.args as Record<string, unknown> : {}
  if (fields.protectedWrite === true) {
    return refuse('protected_path', `Muse marks this as a protected write (${describeSubject(subject)}); a Poise change edits only ordinary files in the checkout`)
  }
  if (typeof subject.workspaceRoot === 'string') {
    const root = checkPath(subject.workspaceRoot, scope.workspace, scope, 'read')
    if (!root.ok) return refuse('outside_workspace', `the request is scoped to ${subject.workspaceRoot}, not the prepared checkout ${scope.workspace}`)
  }
  switch (subject.kind) {
    case 'shell': {
      const command = typeof subject.command === 'string' ? subject.command : stringField(args, 'command', 'cmd')
      if (!command) return refuse('unrecognised_request', 'the shell request carries no command text to check')
      return classifyCommand(command, commandCwd(args, scope), scope)
    }
    case 'fileAccess': {
      const path = typeof subject.path === 'string' ? subject.path : pathFields(args)[0]?.value
      if (!path) return refuse('unrecognised_request', 'the file request names no path to check')
      const access: Access = subject.access === 'read' ? 'read' : 'write'
      const checked = checkPath(path, scope.workspace, scope, access)
      if (!checked.ok) return checked
      return { ok: true, classification: 'workspace_file', reason: `${access} of ${checked.evidence[0]} stays inside the prepared checkout`, evidence: checked.evidence }
    }
    case 'network':
      return refuse('network', `network access (${describeSubject(subject)}) is outside the delegated work: a Poise change is implemented and checked locally`)
    case 'unixSocket':
    case 'process':
      return refuse('unrecognised_command', `${subject.kind} access (${describeSubject(subject)}) is not part of implementing a Poise change`)
    default:
      return classifyGeneric({ ...args, ...(typeof subject.command === 'string' ? { command: subject.command } : {}), ...(typeof subject.path === 'string' ? { path: subject.path } : {}) }, scope)
  }
}

function describeSubject(subject: { command?: unknown, path?: unknown, host?: unknown, target?: unknown, kind: string }): string {
  for (const value of [subject.command, subject.path, subject.host, subject.target]) if (typeof value === 'string' && value) return value
  return subject.kind
}

function classifyCodexPermissions(fields: Record<string, unknown>, scope: SelfChangeScope): Classified {
  const permissions = fields.permissions as { network?: { enabled?: unknown } | null, fileSystem?: { read?: unknown, write?: unknown, entries?: unknown } | null }
  if (permissions.network && permissions.network.enabled) {
    return refuse('network', 'a network permission is outside the delegated work: a Poise change is implemented and checked locally')
  }
  if (typeof fields.cwd === 'string') {
    const cwd = checkPath(fields.cwd, scope.workspace, scope, 'read')
    if (!cwd.ok) return cwd
  }
  const evidence: string[] = []
  const fs = permissions.fileSystem
  const entries: Array<{ path: string, access: Access }> = []
  if (fs) {
    for (const path of asStrings(fs.read)) entries.push({ path, access: 'read' })
    for (const path of asStrings(fs.write)) entries.push({ path, access: 'write' })
    if (Array.isArray(fs.entries)) {
      for (const entry of fs.entries) {
        if (!entry || typeof entry !== 'object') continue
        const { path, access } = entry as { path?: unknown, access?: unknown }
        const mode: Access = access === 'read' ? 'read' : 'write'
        // Codex spells a path as a string or as a tagged path/glob/special.
        if (typeof path === 'string') entries.push({ path, access: mode })
        else if (path && typeof path === 'object') {
          const tagged = path as { type?: unknown, path?: unknown, pattern?: unknown, value?: unknown }
          if (tagged.type === 'path' && typeof tagged.path === 'string') entries.push({ path: tagged.path, access: mode })
          else if (tagged.type === 'glob_pattern' && typeof tagged.pattern === 'string') entries.push({ path: tagged.pattern, access: mode })
          else return refuse('unrecognised_request', `the permission request names a ${String(tagged.type ?? 'special')} location (${String(tagged.value ?? '')}) that is not a path in the checkout`)
        }
      }
    }
  }
  if (!entries.length) return refuse('unrecognised_request', 'the permission request names no path to check')
  for (const entry of entries) {
    const checked = checkPath(entry.path, scope.workspace, scope, entry.access)
    if (!checked.ok) return checked
    evidence.push(...checked.evidence)
  }
  return { ok: true, classification: 'workspace_file', reason: 'the requested file access stays inside the prepared checkout', evidence }
}

/** Claude tool inputs, Grok rawInput and Muse tool args: a shell command
 *  when there is one, otherwise every path-like field, nested included. */
function classifyGeneric(fields: Record<string, unknown>, scope: SelfChangeScope): Classified {
  const command = stringField(fields, 'command', 'cmd')
  if (command !== undefined) return classifyCommand(command, commandCwd(fields, scope), scope)

  const network = findNetworkField(fields)
  if (network) return refuse('network', `${network.key} ${network.value} is a network request; a Poise change is implemented and checked locally`)

  const paths = pathFields(fields)
  if (!paths.length) {
    return refuse('unrecognised_request', `the request has no command or path field Poise can check (fields: ${Object.keys(fields).join(', ') || 'none'}); use the ordinary file and shell tools inside ${scope.workspace}`)
  }
  const access: Access = writesContent(fields) ? 'write' : 'read'
  const evidence: string[] = []
  for (const entry of paths) {
    const checked = checkPath(entry.value, scope.workspace, scope, access)
    if (!checked.ok) return { ...checked, reason: `${entry.key}: ${checked.reason}` }
    evidence.push(...checked.evidence)
  }
  return { ok: true, classification: 'workspace_file', reason: `${access} of ${evidence.length === 1 ? evidence[0] : `${evidence.length} paths`} stays inside the prepared checkout`, evidence }
}

const PATH_KEYS = new Set([
  'file_path', 'filepath', 'path', 'file', 'notebook_path', 'target_file', 'directory', 'dir', 'cwd', 'root',
  'grantroot', 'workspaceroot', 'old_path', 'new_path', 'oldpath', 'newpath', 'source', 'destination', 'src', 'dest', 'target',
  'paths', 'files', 'file_paths', 'filepaths',
])
const NETWORK_KEYS = new Set(['url', 'uri', 'host', 'hostname', 'endpoint'])
const CONTENT_KEYS = new Set(['content', 'contents', 'new_string', 'old_string', 'newstring', 'oldstring', 'edits', 'new_source', 'file_text', 'patch', 'diff', 'text', 'data', 'new_content'])
const MAX_DEPTH = 4

function pathFields(fields: Record<string, unknown>, depth = 0, prefix = ''): Array<{ key: string, value: string }> {
  const found: Array<{ key: string, value: string }> = []
  for (const [key, value] of Object.entries(fields)) {
    const name = key.toLowerCase()
    const label = prefix ? `${prefix}.${key}` : key
    if (PATH_KEYS.has(name)) {
      if (typeof value === 'string' && value) found.push({ key: label, value })
      else if (Array.isArray(value)) for (const item of value) if (typeof item === 'string' && item) found.push({ key: label, value: item })
      continue
    }
    if (CONTENT_KEYS.has(name)) continue
    if (depth < MAX_DEPTH && value && typeof value === 'object') {
      if (Array.isArray(value)) {
        value.forEach((item, index) => { if (item && typeof item === 'object' && !Array.isArray(item)) found.push(...pathFields(item as Record<string, unknown>, depth + 1, `${label}[${index}]`)) })
      } else {
        found.push(...pathFields(value as Record<string, unknown>, depth + 1, label))
      }
    }
  }
  return found
}

function findNetworkField(fields: Record<string, unknown>, depth = 0): { key: string, value: string } | null {
  for (const [key, value] of Object.entries(fields)) {
    const name = key.toLowerCase()
    if (NETWORK_KEYS.has(name) && typeof value === 'string' && value && !/^file:/i.test(value)) return { key, value }
    if (depth < MAX_DEPTH && value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = findNetworkField(value as Record<string, unknown>, depth + 1)
      if (nested) return nested
    }
  }
  return null
}

function writesContent(fields: Record<string, unknown>): boolean {
  return Object.keys(fields).some((key) => CONTENT_KEYS.has(key.toLowerCase()))
}

function stringField(fields: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = fields[key]
    if (typeof value === 'string') return value
  }
  return undefined
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : []
}

function commandCwd(fields: Record<string, unknown>, scope: SelfChangeScope): string {
  return stringField(fields, 'cwd', 'workingDirectory', 'working_dir', 'workdir', 'working_directory') ?? scope.workspace
}

// ── Paths ─────────────────────────────────────────────────────────────────

function defaultRealpath(path: string): string {
  let existing = path
  const rest: string[] = []
  for (;;) {
    try {
      return rest.length ? resolve(realpathSync(existing), ...rest) : realpathSync(existing)
    } catch {
      const parent = dirname(existing)
      if (parent === existing) return path
      rest.unshift(basename(existing))
      existing = parent
    }
  }
}

function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`)
}

/** Resolve one path lexically against `cwd`, then through symlinks, and
 *  require both to land inside the workspace; refuse git internals for
 *  writes and dotenv files for everything. */
function checkPath(raw: string, cwd: string, scope: SelfChangeScope, access: Access): Checked {
  if (!raw) return refuse('unrecognised_request', 'an empty path cannot be checked')
  if (raw.startsWith('~')) return refuse('outside_workspace', `${raw} is relative to the home directory, not to the prepared checkout ${scope.workspace}`)
  if (/[*?[]/.test(raw) && /(^|\/)\.\.(\/|$)/.test(raw)) {
    return refuse('outside_workspace', `${raw} mixes a glob with "..": what it expands to cannot be confined to the checkout`)
  }
  const lexical = trimSlashes(isAbsolute(raw) ? normalize(raw) : resolve(cwd, raw))
  if (!isWithin(lexical, scope.workspace)) {
    return refuse('outside_workspace', `${raw} resolves to ${lexical}, outside the prepared checkout ${scope.workspace}`)
  }
  const real = trimSlashes((scope.realpath ?? defaultRealpath)(lexical))
  if (!isWithin(real, scope.workspace)) {
    return refuse('outside_workspace', `${raw} resolves through a symlink to ${real}, outside the prepared checkout ${scope.workspace}`)
  }
  const relative = lexical === scope.workspace ? '' : lexical.slice(scope.workspace.length + 1)
  const segments = relative.split('/')
  if (segments[0] === '.git' && access === 'write') {
    return refuse('protected_path', `${raw} is inside the checkout's .git directory; the repository state changes only through git add/commit`)
  }
  const name = segments[segments.length - 1]
  if (/^\.env(\..+)?$/.test(name) && name !== '.env.example') {
    return refuse('credentials', `${raw} is a dotenv file; credentials and local secrets are outside the delegated work`)
  }
  return ok([`${access} ${lexical}`])
}

function trimSlashes(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed || '/'
}

// ── Shell commands ────────────────────────────────────────────────────────

type Word = { kind: 'word', text: string, expands: boolean, brace: boolean, quoted: boolean }
type Op = { kind: 'op', text: string }
type Redirect = { kind: 'redirect', op: '<' | '>' | '>>', fd: number, dup: boolean }
type Token = Word | Op | Redirect

class ShellSyntax extends Error {}

function tokenize(command: string): Token[] {
  const tokens: Token[] = []
  let buffer = ''
  let inWord = false
  let expands = false
  let brace = false
  let quoted = false
  let single = false
  let double = false
  const flush = () => {
    if (inWord) tokens.push({ kind: 'word', text: buffer, expands, brace, quoted })
    buffer = ''; inWord = false; expands = false; brace = false; quoted = false
  }
  let i = 0
  while (i < command.length) {
    const ch = command[i]
    if (single) {
      if (ch === '\'') single = false
      else buffer += ch
      i += 1
      continue
    }
    if (double) {
      if (ch === '"') { double = false; i += 1; continue }
      if (ch === '\\' && i + 1 < command.length && '"\\$`\n'.includes(command[i + 1])) { buffer += command[i + 1]; i += 2; continue }
      if (ch === '$' || ch === '`') expands = true
      buffer += ch
      i += 1
      continue
    }
    if (ch === '\'') { single = true; quoted = true; inWord = true; i += 1; continue }
    if (ch === '"') { double = true; quoted = true; inWord = true; i += 1; continue }
    if (ch === '\\') {
      if (i + 1 >= command.length) throw new ShellSyntax('a trailing backslash')
      if (command[i + 1] !== '\n') { buffer += command[i + 1]; inWord = true; quoted = true }
      i += 2
      continue
    }
    if (ch === ' ' || ch === '\t') { flush(); i += 1; continue }
    if (ch === '\n' || ch === '\r') { flush(); tokens.push({ kind: 'op', text: ';' }); i += 1; continue }
    if (ch === '#' && !inWord) {
      while (i < command.length && command[i] !== '\n') i += 1
      continue
    }
    const two = command.slice(i, i + 2)
    if (two === '&&' || two === '||') { flush(); tokens.push({ kind: 'op', text: two }); i += 2; continue }
    if (two === '<<') throw new ShellSyntax('a here-document')
    if (ch === '<' || ch === '>') {
      let fd = ch === '<' ? 0 : 1
      if (inWord && /^[0-9]+$/.test(buffer) && !quoted) { fd = Number(buffer); buffer = ''; inWord = false }
      else flush()
      let op: Redirect['op'] = ch
      i += 1
      if (ch === '>' && command[i] === '>') { op = '>>'; i += 1 }
      else if (ch === '>' && command[i] === '|') i += 1
      if (command[i] === '&') {
        i += 1
        const match = /^([0-9]+|-)/.exec(command.slice(i))
        if (!match) throw new ShellSyntax('a redirection without a descriptor')
        i += match[0].length
        tokens.push({ kind: 'redirect', op, fd, dup: true })
        continue
      }
      tokens.push({ kind: 'redirect', op, fd, dup: false })
      continue
    }
    if (ch === '&' && two === '&>') throw new ShellSyntax('an &> redirection')
    if (ch === ';' || ch === '|' || ch === '&' || ch === '(' || ch === ')') { flush(); tokens.push({ kind: 'op', text: ch }); i += 1; continue }
    if (ch === '$' || ch === '`') expands = true
    if (ch === '~' && !inWord) expands = true
    if (ch === '{' || ch === '}') brace = true
    buffer += ch
    inWord = true
    i += 1
  }
  if (single || double) throw new ShellSyntax('an unterminated quote')
  flush()
  return tokens
}

interface SimpleCommand { argv: Word[], redirects: Array<{ redirect: Redirect, target: Word | null }> }

function parseCommands(tokens: Token[]): SimpleCommand[] {
  const commands: SimpleCommand[] = []
  let current: SimpleCommand = { argv: [], redirects: [] }
  const close = () => {
    if (current.argv.length || current.redirects.length) commands.push(current)
    current = { argv: [], redirects: [] }
  }
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token.kind === 'word') { current.argv.push(token); continue }
    if (token.kind === 'redirect') {
      if (token.dup) { current.redirects.push({ redirect: token, target: null }); continue }
      const target = tokens[i + 1]
      if (!target || target.kind !== 'word') throw new ShellSyntax('a redirection without a target')
      current.redirects.push({ redirect: token, target })
      i += 1
      continue
    }
    switch (token.text) {
      case '&&': case '||': case ';': case '|': close(); break
      case '&': throw new ShellSyntax('a background job (&)')
      case '(': case ')': throw new ShellSyntax('a subshell')
      default: throw new ShellSyntax(`the operator ${token.text}`)
    }
  }
  close()
  return commands
}

const SHELL_CONSTRUCT_HINT = 'write the literal command (single-quote text that must contain $, ` or ~) and run one checkable step at a time'

function classifyCommand(command: string, cwd: string, scope: SelfChangeScope): Classified {
  const trimmed = command.trim()
  if (!trimmed) return refuse('unrecognised_request', 'the command is empty')
  let commands: SimpleCommand[]
  try {
    commands = parseCommands(tokenize(trimmed))
  } catch (error) {
    const what = error instanceof ShellSyntax ? error.message : 'unreadable shell syntax'
    return refuse('shell_construct', `the command uses ${what}, which cannot be checked; ${SHELL_CONSTRUCT_HINT}`)
  }
  if (!commands.length) return refuse('unrecognised_request', 'the command is empty')
  const start = checkPath(cwd, scope.workspace, scope, 'read')
  if (!start.ok) return refuse('outside_workspace', `the working directory ${cwd} is not inside the prepared checkout ${scope.workspace}`)
  const state = { cwd: trimSlashes(isAbsolute(cwd) ? normalize(cwd) : resolve(scope.workspace, cwd)) }
  const evidence: string[] = [`cwd ${state.cwd}`]
  for (const simple of commands) {
    for (const word of simple.argv) {
      const problem = wordProblem(word)
      if (problem) return refuse('shell_construct', `"${word.text}" ${problem}; ${SHELL_CONSTRUCT_HINT}`)
    }
    for (const { redirect, target } of simple.redirects) {
      if (!target) continue
      const problem = wordProblem(target)
      if (problem) return refuse('shell_construct', `the redirection target "${target.text}" ${problem}; ${SHELL_CONSTRUCT_HINT}`)
      if (target.text === '/dev/null') continue
      const checked = checkPath(target.text, state.cwd, scope, redirect.op === '<' ? 'read' : 'write')
      if (!checked.ok) return { ...checked, reason: `redirection: ${checked.reason}` }
      evidence.push(...checked.evidence)
    }
    const argv = simple.argv.map((word) => word.text)
    if (!argv.length) continue
    const checked = checkSimpleCommand(argv, state, scope)
    if (!checked.ok) return checked
    evidence.push(...checked.evidence)
  }
  return { ok: true, classification: 'workspace_command', reason: `local development command inside the prepared checkout on ${scope.branch}`, evidence }
}

function wordProblem(word: Word): string | null {
  if (word.expands) return 'contains a shell expansion ($, backticks or ~) that cannot be checked'
  if (word.brace) return 'contains a brace expansion that cannot be checked'
  return null
}

const ENV_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=/
const HARMLESS_ENV = new Set(['CI', 'NO_COLOR', 'FORCE_COLOR', 'TZ', 'LANG', 'LC_ALL', 'DEBUG', 'NODE_ENV', 'VITEST', 'PWDEBUG'])

function checkSimpleCommand(argv: string[], state: { cwd: string }, scope: SelfChangeScope): Checked {
  let index = 0
  for (;;) {
    const assignment = index < argv.length ? ENV_ASSIGNMENT.exec(argv[index]) : null
    if (!assignment) break
    const name = assignment[1]
    if (!HARMLESS_ENV.has(name) && !name.startsWith('VITEST_')) {
      return refuse('shell_construct', `the environment override ${name}=… cannot be checked; run the command without it`)
    }
    index += 1
  }
  const rest = argv.slice(index)
  if (!rest.length) return refuse('shell_construct', 'an assignment without a command cannot be checked')
  const program = programName(rest[0], state.cwd, scope)
  if (!program.ok) return program
  const args = rest.slice(1)
  const checked = checkProgram(program.name, args, state, scope)
  if (!checked.ok) return checked
  return ok([`run ${rest.join(' ')}`, ...checked.evidence])
}

function programName(word: string, cwd: string, scope: SelfChangeScope): { ok: true, name: string } | Refusal {
  if (!word.includes('/')) return { ok: true, name: word }
  const local = /^(?:\.\/)?node_modules\/\.bin\/([^/]+)$/.exec(word)
  if (local) return { ok: true, name: local[1] }
  const lexical = trimSlashes(isAbsolute(word) ? normalize(word) : resolve(cwd, word))
  if (isWithin(lexical, scope.workspace) && lexical.startsWith(`${scope.workspace}/node_modules/.bin/`)) return { ok: true, name: basename(lexical) }
  return refuse('unrecognised_command', `${word} is not one of the local development tools (npm, npx, git, node, vitest, playwright, eslint, tsc) run by name`)
}

const LOCAL_TOOLS = new Set(['vitest', 'playwright', 'eslint', 'tsc', 'vite', 'prettier'])
const INSPECTION = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'pwd', 'echo', 'printf', 'which', 'true', 'false', 'test', '[', 'sort', 'uniq', 'cut', 'tr', 'diff', 'stat', 'file', 'basename', 'dirname', 'realpath', 'du', 'date', 'sleep', 'tee', 'jq'])
const FILE_OPS = new Set(['mkdir', 'touch', 'rm', 'mv', 'cp', 'chmod', 'rmdir'])
const NPM_SCRIPTS = new Set(['check', 'test', 'lint', 'build', 'build:client', 'build:server', 'typecheck', 'typecheck:client', 'typecheck:server', 'typecheck:tests', 'clean', 'doctor', 'prepare:e2e', 'test:e2e', 'test:e2e:update', 'verify'])
const NPM_INSTALL_FLAGS = new Set(['--include=dev', '--include=optional', '--omit=optional', '--no-audit', '--no-fund', '--prefer-offline', '--ignore-scripts', '--quiet', '--silent', '--no-progress', '--save-dev', '-D', '--save-exact', '-E', '--save', '-S', '--no-save', '--no-package-lock', '--package-lock-only', '--legacy-peer-deps'])
const PACKAGE_SPEC = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[^/\s]+)?$/

const REFUSED_PROGRAMS: Record<string, { classification: SelfChangeRejectClassification, reason: string }> = {
  curl: { classification: 'network', reason: 'downloads and requests are outside the delegated work: a Poise change is implemented and checked locally' },
  wget: { classification: 'network', reason: 'downloads and requests are outside the delegated work: a Poise change is implemented and checked locally' },
  ssh: { classification: 'network', reason: 'remote access is outside the delegated work' },
  scp: { classification: 'network', reason: 'remote access is outside the delegated work' },
  rsync: { classification: 'network', reason: 'remote access is outside the delegated work' },
  nc: { classification: 'network', reason: 'network access is outside the delegated work' },
  pip: { classification: 'network', reason: 'installing packages outside the checkout is not part of a Poise change' },
  pip3: { classification: 'network', reason: 'installing packages outside the checkout is not part of a Poise change' },
  brew: { classification: 'network', reason: 'installing software on this machine is not part of a Poise change' },
  docker: { classification: 'network', reason: 'containers are not part of a Poise change' },
  gh: { classification: 'release_control', reason: 'GitHub operations belong to the release controller: it pushes the commit you leave, opens the PR, merges and releases it' },
  security: { classification: 'credentials', reason: 'the keychain is outside the delegated work' },
  launchctl: { classification: 'release_control', reason: 'services are restarted only by the release controller after the change is merged' },
  kill: { classification: 'release_control', reason: 'other processes are outside the delegated work; Poise is restarted only by the release controller' },
  killall: { classification: 'release_control', reason: 'other processes are outside the delegated work; Poise is restarted only by the release controller' },
  pkill: { classification: 'release_control', reason: 'other processes are outside the delegated work; Poise is restarted only by the release controller' },
  sudo: { classification: 'credentials', reason: 'privilege escalation is outside the delegated work' },
  su: { classification: 'credentials', reason: 'privilege escalation is outside the delegated work' },
  open: { classification: 'interactive', reason: 'opening applications is outside the delegated work' },
  osascript: { classification: 'interactive', reason: 'scripting the desktop is outside the delegated work' },
  defaults: { classification: 'unrecognised_command', reason: 'system preferences are outside the delegated work' },
  crontab: { classification: 'release_control', reason: 'scheduled jobs are outside the delegated work' },
  ln: { classification: 'protected_path', reason: 'symlinks are not accepted in a Poise change; copy or edit files instead' },
  sh: { classification: 'shell_construct', reason: 'a nested shell cannot be checked; run the command directly' },
  bash: { classification: 'shell_construct', reason: 'a nested shell cannot be checked; run the command directly' },
  zsh: { classification: 'shell_construct', reason: 'a nested shell cannot be checked; run the command directly' },
  eval: { classification: 'shell_construct', reason: 'eval cannot be checked; run the command directly' },
  exec: { classification: 'shell_construct', reason: 'exec cannot be checked; run the command directly' },
  source: { classification: 'shell_construct', reason: 'sourcing a script cannot be checked; run the command directly' },
  '.': { classification: 'shell_construct', reason: 'sourcing a script cannot be checked; run the command directly' },
  xargs: { classification: 'shell_construct', reason: 'xargs builds commands that cannot be checked; run the command directly' },
  env: { classification: 'shell_construct', reason: 'env overrides cannot be checked; run the command directly' },
  export: { classification: 'shell_construct', reason: 'environment changes cannot be checked; run the command directly' },
  nohup: { classification: 'interactive', reason: 'detached processes are outside the delegated work' },
  python: { classification: 'unrecognised_command', reason: 'Poise is checked with its npm scripts; python is not part of the local toolset' },
  python3: { classification: 'unrecognised_command', reason: 'Poise is checked with its npm scripts; python is not part of the local toolset' },
  awk: { classification: 'shell_construct', reason: 'awk programs can run commands and cannot be checked; use grep, cut or the file tools' },
  perl: { classification: 'shell_construct', reason: 'perl programs cannot be checked; use the file tools' },
}

function checkProgram(name: string, args: string[], state: { cwd: string }, scope: SelfChangeScope): Checked {
  const refused = REFUSED_PROGRAMS[name]
  if (refused) return refuse(refused.classification, `${name}: ${refused.reason}`)
  switch (name) {
    case 'cd': return checkCd(args, state, scope)
    case 'npm': return checkNpm(args, state, scope)
    case 'npx': return checkNpx(args, state, scope)
    case 'node': return checkNode(args, state, scope)
    case 'git': return checkGit(args, state, scope)
    case 'time': case 'timeout': {
      // The wrapped command is checked as if run directly.
      let j = 0
      if (name === 'timeout') {
        while (j < args.length && args[j].startsWith('-')) j += (args[j] === '-s' || args[j] === '-k') ? 2 : 1
        j += 1 // the duration
      }
      const rest = args.slice(j)
      if (!rest.length) return refuse('unrecognised_command', `${name} without a command`)
      return checkSimpleCommand(rest, state, scope)
    }
    case 'sed': return checkSed(args, state, scope)
  }
  if (LOCAL_TOOLS.has(name)) return checkLocalTool(name, args, state, scope)
  if (INSPECTION.has(name)) return checkInspection(name, args, state, scope)
  if (FILE_OPS.has(name)) return checkFileOp(name, args, state, scope)
  return refuse('unrecognised_command', `${name} is not one of the local development tools a Poise change runs (npm, npx, git, node, vitest, playwright, eslint, tsc, and file inspection); use the file tools or one of those`)
}

function checkCd(args: string[], state: { cwd: string }, scope: SelfChangeScope): Checked {
  const target = args.filter((arg) => arg !== '-P' && arg !== '-L')
  if (target.length !== 1) return refuse('outside_workspace', `cd ${args.join(' ') || '(home)'} leaves the prepared checkout; cd only to a directory inside ${scope.workspace}`)
  if (target[0] === '-') return refuse('shell_construct', 'cd - depends on shell state that cannot be checked')
  const checked = checkPath(target[0], state.cwd, scope, 'read')
  if (!checked.ok) return { ...checked, reason: `cd: ${checked.reason}` }
  state.cwd = trimSlashes(resolve(state.cwd, target[0]))
  return ok([`cd ${state.cwd}`])
}

function isPackageInstall(command: string): boolean {
  try {
    const commands = parseCommands(tokenize(command.trim()))
    return commands.length > 0 && commands.every((simple) => {
      const argv = simple.argv.map((word) => word.text)
      return argv[0] === 'npm' && ['ci', 'install', 'i'].includes(argv[1])
    })
  } catch {
    return false
  }
}

function isRegistryHost(host: unknown): boolean {
  return host === 'registry.npmjs.org'
}

function checkNpm(args: string[], state: { cwd: string }, scope: SelfChangeScope): Checked {
  const [sub, ...rest] = args
  switch (sub) {
    case undefined: return refuse('unrecognised_command', 'npm without a subcommand')
    case '--version': case '-v': return ok()
    case 'ci': case 'install': case 'i': {
      for (let i = 0; i < rest.length; i += 1) {
        const arg = rest[i]
        if (arg === '--include' || arg === '--omit') {
          const value = rest[i + 1]
          if (value !== 'dev' && value !== 'optional') return refuse('unrecognised_command', `npm ${sub} ${arg} ${value ?? ''} is not the dependency install a Poise change needs`)
          i += 1
          continue
        }
        if (arg.startsWith('--loglevel')) continue
        if (arg.startsWith('-')) {
          if (NPM_INSTALL_FLAGS.has(arg)) continue
          if (/^--?(registry|prefix|global|g|userconfig|globalconfig|cache|script-shell|before|ignore-workspace-root-check|workspace)\b/.test(arg) || arg === '-g') {
            return refuse('network', `npm ${sub} ${arg} changes where npm installs from or to; a Poise change installs the checkout's own dependencies from the registry only`)
          }
          return refuse('unrecognised_command', `npm ${sub} ${arg} is not part of installing the checkout's dependencies (allowed: --include=dev and the usual save/audit/fund flags)`)
        }
        if (sub === 'ci') return refuse('unrecognised_command', `npm ci takes no package arguments (${arg})`)
        if (!PACKAGE_SPEC.test(arg)) return refuse('network', `npm ${sub} ${arg}: only registry package names can be installed, not paths, git or URL specs`)
      }
      return ok()
    }
    case 'run': case 'run-script': {
      const script = rest[0]
      if (!script) return refuse('unrecognised_command', 'npm run without a script name')
      return checkNpmScript(script, rest.slice(1), state, scope)
    }
    case 'test': case 't': return checkNpmScript('test', rest, state, scope)
    case 'ls': case 'list': case 'll': return ok()
    case 'uninstall': case 'remove': case 'rm': case 'un': case 'r': {
      const bad = rest.find((arg) => !arg.startsWith('-') && !PACKAGE_SPEC.test(arg))
      if (bad) return refuse('unrecognised_command', `npm ${sub} ${bad} is not a package name`)
      if (rest.some((arg) => arg === '-g' || arg === '--global')) return refuse('outside_workspace', `npm ${sub} --global reaches outside the checkout`)
      return ok()
    }
    case 'publish': case 'login': case 'adduser': case 'logout': case 'token': case 'whoami': case 'deprecate': case 'owner': case 'access':
      return refuse('credentials', `npm ${sub} uses registry credentials; publishing is outside the delegated work`)
    case 'config': case 'set': case 'get': case 'link': case 'exec': case 'x': case 'init': case 'create': case 'update': case 'audit': case 'outdated': case 'view': case 'info': case 'search': case 'cache':
      return refuse('unrecognised_command', `npm ${sub} is not part of implementing and checking a Poise change (use npm ci, npm run check/test/build, npx vitest/eslint/tsc)`)
    default:
      return refuse('unrecognised_command', `npm ${sub} is not part of implementing and checking a Poise change (use npm ci, npm run check/test/build, npx vitest/eslint/tsc)`)
  }
}

function checkNpmScript(script: string, args: string[], state: { cwd: string }, scope: SelfChangeScope): Checked {
  if (script === 'dev' || script === 'start' || script === 'preview' || script === 'start:production' || script === 'test:watch') {
    return refuse('interactive', `npm run ${script} starts a server or watcher that never finishes; a Poise change runs npm run check (and npx vitest/playwright for single suites)`)
  }
  if (script.startsWith('install:') || script.startsWith('update:') || script.startsWith('monitor:')) {
    return refuse('release_control', `npm run ${script} manages the production install; the release controller deploys the change after it is merged`)
  }
  if (!NPM_SCRIPTS.has(script)) {
    return refuse('unrecognised_command', `npm run ${script} is not one of the check/test/build scripts a Poise change runs (${[...NPM_SCRIPTS].join(', ')})`)
  }
  const forwarded = args[0] === '--' ? args.slice(1) : args
  const paths = checkPathArguments(forwarded, state, scope)
  if (!paths.ok) return paths
  return ok(paths.evidence)
}

function checkNpx(args: string[], state: { cwd: string }, scope: SelfChangeScope): Checked {
  let i = 0
  for (; i < args.length && args[i].startsWith('-'); i += 1) {
    const flag = args[i]
    if (flag === '--no-install' || flag === '--no' || flag === '--offline' || flag === '--prefer-offline' || flag === '-q' || flag === '--quiet') continue
    if (flag === '-p' || flag === '--package' || flag.startsWith('--package=') || flag === '-y' || flag === '--yes' || flag === '-c' || flag === '--call') {
      return refuse('network', `npx ${flag} fetches or runs packages that are not the checkout's own tools`)
    }
    return refuse('unrecognised_command', `npx ${flag} is not needed to run the checkout's own tools`)
  }
  const tool = args[i]
  if (!tool) return refuse('unrecognised_command', 'npx without a tool')
  if (!LOCAL_TOOLS.has(tool)) {
    return refuse('network', `npx ${tool} would fetch or run a tool that is not one of the checkout's own (vitest, playwright, eslint, tsc, vite)`)
  }
  return checkLocalTool(tool, args.slice(i + 1), state, scope)
}

function checkLocalTool(tool: string, args: string[], state: { cwd: string }, scope: SelfChangeScope): Checked {
  switch (tool) {
    case 'vitest':
      if (args.some((arg) => arg === '--watch' || arg === '-w' || arg === '--ui' || arg === 'watch' || arg === 'dev')) {
        return refuse('interactive', 'vitest in watch/UI mode never finishes; run `npx vitest run …`')
      }
      break
    case 'playwright':
      if (args[0] === 'install' || args[0] === 'install-deps') return refuse('network', 'playwright install downloads browsers; the checkout is checked with the browsers already on this machine')
      if (args[0] !== 'test') return refuse('interactive', `playwright ${args[0] ?? ''} is not the test run a Poise change needs (npx playwright test …)`)
      if (args.some((arg) => arg === '--ui' || arg === '--headed' || arg === '--debug')) return refuse('interactive', 'playwright in UI/headed/debug mode waits for a person; run it headless')
      break
    case 'vite':
      if (args[0] !== 'build') return refuse('interactive', `vite ${args[0] ?? ''} starts a server; a Poise change runs npm run build (or npx vite build)`)
      break
  }
  const paths = checkPathArguments(args, state, scope)
  if (!paths.ok) return paths
  return ok(paths.evidence)
}

function checkNode(args: string[], state: { cwd: string }, scope: SelfChangeScope): Checked {
  let i = 0
  for (; i < args.length && args[i].startsWith('-'); i += 1) {
    const flag = args[i]
    if (flag === '--version' || flag === '-v') return ok()
    if (flag === '--test' || flag === '--enable-source-maps' || flag === '--no-warnings' || flag.startsWith('--stack-trace-limit') || flag.startsWith('--test-')) continue
    return refuse('shell_construct', `node ${flag} runs code that is not a file in the checkout (or changes how it loads); run node <script in the checkout> instead`)
  }
  const script = args[i]
  if (!script) return refuse('shell_construct', 'node without a script runs an interactive REPL; run node <script in the checkout>')
  const checked = checkPath(script, state.cwd, scope, 'read')
  if (!checked.ok) return { ...checked, reason: `node: ${checked.reason}` }
  const paths = checkPathArguments(args.slice(i + 1), state, scope)
  if (!paths.ok) return paths
  return ok([...checked.evidence, ...paths.evidence])
}

function checkSed(args: string[], state: { cwd: string }, scope: SelfChangeScope): Checked {
  // Only the read-only "print these lines" form; edits go through the file
  // tools, and sed scripts (e, w, r) can run commands or write elsewhere.
  const files: string[] = []
  let script: string | null = null
  let quiet = false
  for (const arg of args) {
    if (arg === '-n' || arg === '--quiet' || arg === '--silent') { quiet = true; continue }
    if (arg === '-E' || arg === '-r') continue
    if (arg.startsWith('-')) return refuse('shell_construct', `sed ${arg} is not the read-only line print (sed -n '10,20p' file); edit files with the file tools`)
    if (script === null) script = arg
    else files.push(arg)
  }
  if (!quiet || script === null || !/^[0-9]+(,([0-9]+|\$))?p$/.test(script) || !files.length) {
    return refuse('shell_construct', 'only the read-only line print form of sed is checkable (sed -n \'10,20p\' file); edit files with the file tools')
  }
  const paths = checkPathArguments(files, state, scope)
  if (!paths.ok) return paths
  return ok(paths.evidence)
}

function checkInspection(name: string, args: string[], state: { cwd: string }, scope: SelfChangeScope): Checked {
  if (name === 'find') {
    const bad = args.find((arg) => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(arg))
    if (bad) return refuse('shell_construct', `find ${bad} runs commands or writes files; use find to list, then act with the file tools`)
  }
  if (name === 'rg' && args.some((arg) => arg === '--pre' || arg.startsWith('--pre='))) {
    return refuse('shell_construct', 'rg --pre runs a preprocessor command that cannot be checked')
  }
  if (name === 'tee') {
    const targets = args.filter((arg) => !arg.startsWith('-'))
    if (!targets.length) return ok()
    const paths = checkPathArguments(targets, state, scope, 'write', true)
    if (!paths.ok) return paths
    return ok(paths.evidence)
  }
  const paths = checkPathArguments(args, state, scope)
  if (!paths.ok) return paths
  return ok(paths.evidence)
}

function checkFileOp(name: string, args: string[], state: { cwd: string }, scope: SelfChangeScope): Checked {
  const targets = args.filter((arg) => !arg.startsWith('-'))
  if (!targets.length) return refuse('unrecognised_command', `${name} without a path`)
  const paths = checkPathArguments(targets, state, scope, 'write', true)
  if (!paths.ok) return paths
  if (name === 'rm') {
    for (const target of targets) {
      const lexical = trimSlashes(resolve(state.cwd, target))
      if (lexical === scope.workspace) return refuse('protected_path', 'rm of the prepared checkout itself is not part of the change')
    }
  }
  return ok(paths.evidence)
}

/** Arguments that name paths — absolute, home-relative, or containing a
 *  path separator or ".." — must stay in the checkout. Bare words (test
 *  names, patterns, flags) are left alone; `always` checks every one. */
function checkPathArguments(args: string[], state: { cwd: string }, scope: SelfChangeScope, access: Access = 'read', always = false): Checked {
  const evidence: string[] = []
  for (const arg of args) {
    if (arg.startsWith('-') && !always) {
      const eq = arg.indexOf('=')
      const value = eq > 0 ? arg.slice(eq + 1) : ''
      if (!looksLikePath(value)) continue
      const checked = checkPath(value, state.cwd, scope, access)
      if (!checked.ok) return { ...checked, reason: `${arg}: ${checked.reason}` }
      evidence.push(...checked.evidence)
      continue
    }
    if (!always && !looksLikePath(arg)) continue
    const checked = checkPath(arg, state.cwd, scope, access)
    if (!checked.ok) return checked
    evidence.push(...checked.evidence)
  }
  return ok(evidence)
}

function looksLikePath(value: string): boolean {
  return value.startsWith('/') || value.startsWith('~') || value.startsWith('.') || value.includes('/')
}

// ── git ───────────────────────────────────────────────────────────────────

const GIT_READ_ONLY = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'rev-list', 'cat-file', 'check-ignore', 'grep', 'shortlog', 'name-rev', 'merge-base', 'diff-tree', 'diff-index', 'ls-tree', 'var', 'version', '--version', 'count-objects', 'for-each-ref', 'show-ref'])
const GIT_RELEASE = new Set(['push', 'pull', 'fetch', 'clone', 'submodule', 'worktree', 'remote', 'send-pack', 'request-pull', 'archive', 'bundle', 'daemon', 'instaweb', 'svn', 'lfs'])
const GIT_HISTORY = new Set(['reset', 'checkout', 'switch', 'rebase', 'merge', 'cherry-pick', 'revert', 'stash', 'branch', 'tag', 'am', 'filter-branch', 'filter-repo', 'update-ref', 'symbolic-ref', 'reflog', 'gc', 'prune', 'fsck', 'replace', 'notes', 'bisect', 'init', 'read-tree', 'write-tree', 'commit-tree', 'apply', 'mergetool', 'difftool', 'format-patch', 'maintenance', 'repack', 'pack-refs'])

function checkGit(args: string[], state: { cwd: string }, scope: SelfChangeScope): Checked {
  const evidence: string[] = []
  let i = 0
  for (; i < args.length && args[i].startsWith('-'); i += 1) {
    const flag = args[i]
    if (flag === '--no-pager' || flag === '-P' || flag === '--no-optional-locks' || flag === '--literal-pathspecs') continue
    if (flag === '--version' || flag === '--help') return ok()
    if (flag === '-C') {
      const dir = args[i + 1]
      if (!dir) return refuse('unrecognised_command', 'git -C without a directory')
      const checked = checkPath(dir, state.cwd, scope, 'read')
      if (!checked.ok) return { ...checked, reason: `git -C: ${checked.reason}` }
      evidence.push(...checked.evidence)
      i += 1
      continue
    }
    if (flag === '-c' || flag.startsWith('--git-dir') || flag.startsWith('--work-tree') || flag.startsWith('--exec-path') || flag.startsWith('--namespace') || flag.startsWith('--config-env')) {
      return refuse('credentials', `git ${flag} overrides repository configuration; a Poise change uses the prepared checkout as it is`)
    }
    return refuse('unrecognised_command', `git ${flag} is not part of the status/diff/log/add/commit work of a Poise change`)
  }
  const sub = args[i]
  const rest = args.slice(i + 1)
  if (!sub) return refuse('unrecognised_command', 'git without a subcommand')
  if (rest.some((arg) => arg.startsWith('--output'))) return refuse('shell_construct', `git ${sub} --output writes outside the command; redirect inside the checkout instead`)

  if (GIT_RELEASE.has(sub)) {
    return refuse('release_control', `git ${sub} is not part of a Poise change: the release controller pushes the exact commit you leave on ${scope.branch}, opens the PR, merges and releases it`)
  }
  if (sub === 'branch' && (rest.length === 0 || rest.every((arg) => arg === '--show-current' || arg === '--list' || arg === '-v' || arg === '-vv' || arg === '-a' || arg === '--no-color'))) return ok()
  if (sub === 'tag' && (rest.length === 0 || rest.every((arg) => arg === '-l' || arg === '--list' || arg === '-n'))) return ok()
  if (sub === 'stash' && rest[0] === 'list') return ok()
  if (sub === 'remote' && (rest.length === 0 || rest[0] === '-v' || rest[0] === 'show')) return ok()
  if (GIT_HISTORY.has(sub)) {
    return refuse('release_control', `git ${sub} changes the branch or working tree state; the checkout stays on ${scope.branch} as prepared — implement, git add, git commit, and leave the rest to the release controller`)
  }
  if (sub === 'config') return checkGitConfig(rest)
  if (GIT_READ_ONLY.has(sub)) {
    if (sub === 'diff' && rest.some((arg) => arg === '--ext-diff' || arg.startsWith('--textconv'))) return refuse('shell_construct', 'git diff with external tools cannot be checked')
    const paths = checkPathArguments(rest, state, scope)
    if (!paths.ok) return paths
    return ok([...evidence, ...paths.evidence])
  }
  switch (sub) {
    case 'add': {
      const bad = rest.find((arg) => arg === '-p' || arg === '--patch' || arg === '-i' || arg === '--interactive' || arg === '-e' || arg === '--edit')
      if (bad) return refuse('interactive', `git add ${bad} waits for a person; add whole paths instead`)
      const paths = checkPathArguments(rest.filter((arg) => !arg.startsWith('-')), state, scope, 'write', true)
      if (!paths.ok) return paths
      return ok([...evidence, ...paths.evidence])
    }
    case 'commit': return checkGitCommit(rest, state, scope, evidence)
    case 'rm': case 'mv': case 'restore': case 'clean': {
      if (sub === 'restore' && rest.some((arg) => arg.startsWith('--source'))) return refuse('release_control', 'git restore --source rewrites files from another revision; edit them instead')
      if (sub === 'clean' && rest.some((arg) => arg === '-i' || arg === '--interactive')) return refuse('interactive', 'git clean -i waits for a person')
      const paths = checkPathArguments(rest.filter((arg) => !arg.startsWith('-')), state, scope, 'write', true)
      if (!paths.ok) return paths
      return ok([...evidence, ...paths.evidence])
    }
    default:
      return refuse('unrecognised_command', `git ${sub} is not part of the status/diff/log/add/commit work of a Poise change`)
  }
}

function checkGitConfig(rest: string[]): Checked {
  if (rest.some((arg) => arg === '--global' || arg === '--system' || arg.startsWith('--file') || arg === '-f' || arg === '--worktree' || arg.startsWith('--blob'))) {
    return refuse('credentials', 'git config outside the checkout is not part of a Poise change')
  }
  const positional = rest.filter((arg) => !arg.startsWith('-'))
  if (rest.some((arg) => arg === '--list' || arg === '-l' || arg === '--get' || arg === '--get-all')) return ok()
  if (positional.length === 2 && (positional[0] === 'user.name' || positional[0] === 'user.email')) return ok()
  if (positional.length === 1) return ok()
  return refuse('credentials', `git config ${positional[0] ?? ''} changes how the checkout behaves; only user.name and user.email may be set for the commit`)
}

function checkGitCommit(rest: string[], state: { cwd: string }, scope: SelfChangeScope, evidence: string[]): Checked {
  let hasMessage = false
  const paths: string[] = []
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]
    if (arg === '--amend') return refuse('release_control', `git commit --amend rewrites history on ${scope.branch}; make a new commit instead — the release controller pushes the commits you leave`)
    if (arg === '-S' || arg.startsWith('--gpg-sign') || arg === '--no-gpg-sign') return refuse('credentials', 'commit signing uses keys outside the delegated work')
    if (arg === '-e' || arg === '--edit' || arg === '-c' || arg === '-C' || arg.startsWith('--reedit-message') || arg.startsWith('--reuse-message')) return refuse('interactive', `git commit ${arg} opens an editor; pass the message with -m`)
    if (arg === '-p' || arg === '--patch' || arg === '--interactive' || arg === '-i') return refuse('interactive', `git commit ${arg} waits for a person; commit whole paths instead`)
    if (arg === '-m' || arg === '--message') { hasMessage = true; i += 1; continue }
    if (arg.startsWith('-m') || arg.startsWith('--message=')) { hasMessage = true; continue }
    if (arg === '-am' || arg === '-qm') { hasMessage = true; i += 1; continue }
    if (arg === '-F' || arg === '--file') {
      const file = rest[i + 1]
      if (!file) return refuse('unrecognised_command', 'git commit -F without a file')
      const checked = checkPath(file, state.cwd, scope, 'read')
      if (!checked.ok) return { ...checked, reason: `git commit -F: ${checked.reason}` }
      evidence.push(...checked.evidence)
      hasMessage = true
      i += 1
      continue
    }
    if (arg.startsWith('--file=')) {
      const checked = checkPath(arg.slice('--file='.length), state.cwd, scope, 'read')
      if (!checked.ok) return { ...checked, reason: `git commit --file: ${checked.reason}` }
      evidence.push(...checked.evidence)
      hasMessage = true
      continue
    }
    if (arg === '--') { paths.push(...rest.slice(i + 1)); break }
    if (arg.startsWith('-')) {
      if (/^(-a|--all|-q|--quiet|-v|--verbose|-n|--no-verify|--allow-empty|--allow-empty-message|-s|--signoff|--no-edit|--no-status|--author=.*|--date=.*|--cleanup=.*|-o|--only|--include|--no-post-rewrite|--untracked-files.*|-u.*)$/.test(arg)) continue
      return refuse('unrecognised_command', `git commit ${arg} is not part of an ordinary commit (use -m, -a, --author)`)
    }
    paths.push(arg)
  }
  if (!hasMessage) return refuse('interactive', 'git commit without -m opens an editor; pass the message with -m')
  const checked = checkPathArguments(paths, state, scope, 'write', true)
  if (!checked.ok) return checked
  return ok([...evidence, ...checked.evidence])
}
