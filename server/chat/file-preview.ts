// Read-only previews for session files and tracked Poise source.
import { constants } from 'node:fs'
import { lstat, open, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { HttpError } from '../http'
import { localCheckoutPath } from '../gh'
import { runFile } from '../process'
import { POISE_ROOT } from './local-workspace'
import { resolveInsideCheckout } from './git'
import { chatFileReference, type ChatFilePreview } from '../../src/chat-file-reference'

const MAX_BYTES = 512 * 1024
const MAX_LINES = 5000
interface PreviewRoots { poiseRoot?: string, sourceCheckout?: () => Promise<string> }

async function poiseSourceCheckout(): Promise<string> {
  // Resolve only this application's repository, never one supplied by a link.
  const pkg = JSON.parse(await readFile(join(POISE_ROOT, 'package.json'), 'utf8'))
  const repo = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(pkg.repository?.url || '')
  if (!repo) throw new Error('No source checkout configured')
  const root = await localCheckoutPath(repo[1], repo[2])
  const remote = (await runFile('git', ['remote', 'get-url', 'origin'], { cwd: root })).stdout.trim()
  const slug = remote.replace(/^git@github\.com:/, '').replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '')
  if (slug.toLowerCase() !== `${repo[1]}/${repo[2]}`.toLowerCase()) throw new Error('Source checkout identity does not match Poise')
  return root
}

function visiblePath(relative: string): boolean {
  return relative.split('/').every(part => !part.startsWith('.') && !/^(?:credentials|secrets)(?:\.|$)/i.test(part))
    && !/\.(?:pem|key|p12|pfx|sqlite3?|db)$/i.test(relative)
}

async function scopedPath(root: string, path: string, trackedOnly: boolean): Promise<string | null> {
  let resolved: Awaited<ReturnType<typeof resolveInsideCheckout>>
  try { resolved = await resolveInsideCheckout(root, path) } catch { return null }
  if (!visiblePath(resolved.relative)) throw new HttpError(403, 'Private files cannot be previewed')
  if (trackedOnly) {
    const args = ['--literal-pathspecs', 'ls-files', '--cached', '-z', '--', resolved.relative]
    const result = await runFile('git', args, { cwd: root })
    if (!result.stdout.split('\0').includes(resolved.relative)) throw new HttpError(403, 'Only tracked Poise source files can be previewed outside the session workspace')
  }
  return resolved.absolute
}

export async function readChatFile(checkout: string, reference: string, roots: PreviewRoots = {}): Promise<ChatFilePreview> {
  const ref = chatFileReference(reference)
  if (!ref) throw new HttpError(400, 'Invalid local file reference')
  const path = ref.path.startsWith('~/') ? join(homedir(), ref.path.slice(2)) : ref.path
  const requested = isAbsolute(path) ? path : join(checkout, path)
  try {
    if ((await lstat(requested)).isSymbolicLink()) throw new HttpError(403, 'Symbolic links cannot be previewed')
  } catch (error: any) { if (error.code !== 'ENOENT') throw error }
  let absolute = await scopedPath(checkout, path, false)
  if (!absolute && isAbsolute(path)) absolute = await scopedPath(roots.poiseRoot || POISE_ROOT, path, true)
  if (!absolute && isAbsolute(path)) {
    let source: string | undefined
    try { source = await (roots.sourceCheckout || poiseSourceCheckout)() } catch { /* no configured source */ }
    if (source) absolute = await scopedPath(source, path, true)
  }
  if (!absolute) throw new HttpError(403, 'This link is outside the session workspace and Poise source checkout')
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch((error: NodeJS.ErrnoException) => { throw new HttpError(error.code === 'ENOENT' ? 404 : 403, error.code === 'ENOENT' ? 'File no longer exists' : 'File cannot be opened safely') })
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new HttpError(415, 'Only regular text files can be previewed')
    if (info.size > MAX_BYTES) throw new HttpError(413, 'File is too large to preview (512 KiB limit)')
    const buffer = Buffer.alloc(MAX_BYTES + 1)
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const next = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
      if (!next.bytesRead) break
      bytesRead += next.bytesRead
    }
    if (bytesRead > MAX_BYTES) throw new HttpError(413, 'File is too large to preview (512 KiB limit)')
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)) }
    catch { throw new HttpError(415, 'Only UTF-8 text files can be previewed') }
    if (text.includes('\0')) throw new HttpError(415, 'Binary files cannot be previewed')
    const lines = text.split('\n')
    return { path: absolute, text: lines.slice(0, MAX_LINES).join('\n'),
      line: ref.line, endLine: ref.endLine, truncated: lines.length > MAX_LINES }
  } finally { await handle.close() }
}
