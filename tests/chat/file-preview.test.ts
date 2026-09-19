import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chatFileReference } from '../../src/chat-file-reference'
import { renderMarkdown } from '../../src/markdown'

let root: string, workspace: string, source: string
let readChatFile: typeof import('../../server/chat/file-preview').readChatFile
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-file-preview-'))
  workspace = join(root, 'workspace'); source = join(root, 'source')
  await mkdir(workspace); await mkdir(source)
  vi.stubEnv('POISE_DB', join(root, 'chat.db'))
  ;({ readChatFile } = await import('../../server/chat/file-preview'))
  execFileSync('git', ['init', '-q'], { cwd: source })
  await writeFile(join(source, 'README.md'), 'source readme\nsecond line')
  execFileSync('git', ['add', 'README.md'], { cwd: source })
  await writeFile(join(workspace, 'README.md'), '# Session document\nhello\n')
})
afterAll(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })
const roots = () => ({ poiseRoot: source, sourceCheckout: vi.fn(async () => source) })

describe('local file reference rendering', () => {
  it('renders file paths as in-app links only when explicitly enabled', () => {
    const md = '[README.md](/Users/example/dev/Poise/README.md)'
    expect(renderMarkdown(md)).toContain('[README.md]')
    expect(renderMarkdown(md, { localFileLinks: true })).toContain('data-chat-file="/Users/example/dev/Poise/README.md"')
  })
  it('parses absolute, relative, tilde, file URI and line-number destinations', () => {
    expect(chatFileReference('README.md#L2-L4')).toEqual({ path: 'README.md', line: 2, endLine: 4 })
    expect(chatFileReference('./src/main.ts:12:3')).toEqual({ path: './src/main.ts', line: 12, endLine: 12 })
    expect(chatFileReference('file:///tmp/a%20b.md#L3')).toEqual({ path: '/tmp/a b.md', line: 3, endLine: 3 })
    expect(chatFileReference('~/dev/Poise/README.md')).toEqual({ path: '~/dev/Poise/README.md' })
  })
  it('never treats external or executable schemes as local file links', () => {
    for (const url of ['javascript:alert(1)', 'javascript%3Aalert', 'data:text/html,test', '//host/file', 'file://host/file', 'a%00.md', '#L2', 'x.md#L0', 'x.md#L9-L3']) {
      expect(chatFileReference(url)).toBeNull()
      expect(renderMarkdown(`[file](${url})`, { localFileLinks: true })).not.toContain('data-chat-file=')
    }
    expect(renderMarkdown('[web](https://example.com/?a=1&b=2)', { localFileLinks: true })).toContain('href="https://example.com/?a=1&amp;b=2"')
    expect(renderMarkdown('`[file](README.md)`', { localFileLinks: true })).not.toContain('data-chat-file=')
  })
})

describe('bounded, read-only file preview', () => {
  it('reads a session document, preserving references to lines', async () => {
    const options = roots()
    expect(await readChatFile(workspace, 'README.md#L2', options)).toMatchObject({ text: '# Session document\nhello\n', line: 2, truncated: false })
    expect(options.sourceCheckout).not.toHaveBeenCalled()
    expect(await readChatFile(workspace, join(workspace, 'README.md'), options)).toMatchObject({ text: '# Session document\nhello\n' })
  })
  it('allows tracked Poise source but refuses untracked source and relative escapes', async () => {
    expect(await readChatFile(workspace, join(source, 'README.md'), roots())).toMatchObject({ text: 'source readme\nsecond line' })
    await writeFile(join(source, 'private.txt'), 'private')
    await expect(readChatFile(workspace, join(source, 'private.txt'), roots())).rejects.toMatchObject({ statusCode: 403 })
    await expect(readChatFile(workspace, '../source/README.md', roots())).rejects.toMatchObject({ statusCode: 403 })
  })
  it('limits a separately configured source checkout to tracked files too', async () => {
    const options = { poiseRoot: workspace, sourceCheckout: vi.fn(async () => source) }
    expect(await readChatFile(workspace, join(source, 'README.md'), options)).toMatchObject({ text: 'source readme\nsecond line' })
    expect(options.sourceCheckout).toHaveBeenCalledOnce()
  })
  it('rejects private paths, outside files and symbolic links', async () => {
    await writeFile(join(workspace, '.env'), 'private')
    await writeFile(join(root, 'outside.txt'), 'outside')
    await symlink(join(root, 'outside.txt'), join(workspace, 'shortcut.txt'))
    await symlink(source, join(workspace, 'shortcut-dir'))
    for (const path of ['.env', 'shortcut.txt', 'shortcut-dir/README.md', join(root, 'outside.txt'), '%2e%2e/outside.txt', '.git/config']) {
      await expect(readChatFile(workspace, path, roots())).rejects.toMatchObject({ statusCode: 403 })
    }
  })
  it('rejects missing, binary and oversized files without unbounded reads', async () => {
    await writeFile(join(workspace, 'binary'), Buffer.from([0, 1, 2]))
    await writeFile(join(workspace, 'large.txt'), 'x'.repeat(512 * 1024 + 1))
    await expect(readChatFile(workspace, 'missing.md', roots())).rejects.toMatchObject({ statusCode: 404 })
    await expect(readChatFile(workspace, 'binary', roots())).rejects.toMatchObject({ statusCode: 415 })
    await expect(readChatFile(workspace, 'large.txt', roots())).rejects.toMatchObject({ statusCode: 413 })
    await expect(readChatFile(workspace, 'javascript:alert(1)', roots())).rejects.toMatchObject({ statusCode: 400 })
  })
  it('bounds the line count while keeping plain text inert', async () => {
    await writeFile(join(workspace, 'lines.html'), '<script>alert(1)</script>\n' + 'line\n'.repeat(6000))
    const result = await readChatFile(workspace, 'lines.html', roots())
    expect(result.text).toContain('<script>alert(1)</script>')
    expect(result.truncated).toBe(true)
    expect(result.text.split('\n')).toHaveLength(5000)
  })
})

it('authorizes file previews through the session and existing origin policy without waking an agent', async () => {
  const { createServer } = await import('node:http')
  const { handleChatApi } = await import('../../server/chat/transport')
  const { HttpError, enforceApiRequest } = await import('../../server/http')
  const prompt = vi.fn(), resume = vi.fn(), create = vi.fn()
  const get = vi.fn((id: string) => {
    if (id === 'foreign') throw new HttpError(409, 'Session belongs to another instance')
    return id === 'own' ? { checkout: workspace } : null
  })
  const runtime = { get, prompt, resume, create } as unknown as import('../../server/chat/runtime').ChatRuntime
  const server = createServer((req, res) => {
    try { enforceApiRequest(req) } catch { res.writeHead(403); res.end(); return }
    void handleChatApi(req, res, req.url || '', runtime)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/chat/file`
  try {
    expect(await (await fetch(`${base}?session=own&path=README.md`)).json()).toMatchObject({ text: '# Session document\nhello\n' })
    expect((await fetch(`${base}?session=unknown&path=README.md`)).status).toBe(404)
    expect((await fetch(`${base}?session=foreign&path=README.md`)).status).toBe(409)
    expect((await fetch(`${base}?session=own&path=README.md`, { headers: { Origin: 'https://foreign.invalid' } })).status).toBe(403)
    expect(get).toHaveBeenCalledTimes(3)
    expect(prompt).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled()
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})
