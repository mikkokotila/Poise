import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'
import type { AnnotationsFile } from '../server/editor'

type EditorModule = typeof import('../server/editor')

let editor: EditorModule
let editorDir: string
let previousEditorDir: string | undefined
let recentTempName = ''
let workerRoot: string
let workerScriptPath: string

interface WorkerJob {
  operation: 'doc' | 'annotations'
  slug: string
  content?: string
  annotations?: AnnotationsFile
  context: {
    clientId: string
    revision: number
    baseVersion: string
  }
}

type WorkerResult =
  | { ok: true, value: Record<string, unknown> }
  | {
    ok: false
    name?: string
    code?: string
    currentVersion?: string
    message?: string
  }

interface WorkerHandle {
  ready: Promise<void>
  result: Promise<WorkerResult>
}

function startEditorWorker(job: WorkerJob): WorkerHandle {
  const child = spawn(process.execPath, [workerScriptPath], {
    env: {
      ...process.env,
      POISE_EDITOR_DIR: editorDir,
      EDITOR_JOB: JSON.stringify(job),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  let readySeen = false
  let resolveReady!: () => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const result = new Promise<WorkerResult>((resolve, reject) => {
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (!readySeen && stdout.split('\n').includes('READY')) {
        readySeen = true
        resolveReady()
      }
    })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.once('error', (error) => {
      if (!readySeen) rejectReady(error)
      reject(error)
    })
    child.once('close', (code) => {
      if (!readySeen) rejectReady(new Error(`editor worker exited before ready (${code}): ${stderr}`))
      const line = stdout.split('\n').find((value) => value.startsWith('RESULT '))
      if (!line) {
        reject(new Error(`editor worker produced no result (${code}): ${stderr}`))
        return
      }
      resolve(JSON.parse(line.slice('RESULT '.length)) as WorkerResult)
    })
  })
  return { ready, result }
}

function releaseBlocker(blocker: InstanceType<typeof Database>): void {
  if (blocker.inTransaction) blocker.exec('COMMIT')
  if (blocker.open) blocker.close()
}

beforeAll(async () => {
  editorDir = await mkdtemp(join(tmpdir(), 'poise-editor-test-'))
  await writeFile(join(editorDir, 'orphan.md.tmp.123.456.1'), 'partial', 'utf8')
  recentTempName = `active.md.tmp.999999.${Date.now()}.1`
  await writeFile(join(editorDir, recentTempName), 'active', 'utf8')
  previousEditorDir = process.env.POISE_EDITOR_DIR
  process.env.POISE_EDITOR_DIR = editorDir
  vi.resetModules()
  editor = await import('../server/editor')
  await editor.listDocs()

  workerRoot = await mkdtemp(join(process.cwd(), 'node_modules', '.poise-editor-worker-'))
  const workerModulePath = join(workerRoot, 'editor.mjs')
  workerScriptPath = join(workerRoot, 'worker.mjs')
  await build({
    entryPoints: [join(process.cwd(), 'server', 'editor.ts')],
    outfile: workerModulePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    packages: 'external',
    logLevel: 'silent',
  })
  await writeFile(workerScriptPath, `
    import * as editor from './editor.mjs'
    const job = JSON.parse(process.env.EDITOR_JOB)
    process.stdout.write('READY\\n')
    try {
      const value = job.operation === 'doc'
        ? await editor.writeDoc(job.slug, job.content, job.context)
        : await editor.writeAnnotations(job.slug, job.annotations, job.context)
      process.stdout.write('RESULT ' + JSON.stringify({ ok: true, value }) + '\\n')
    } catch (error) {
      process.stdout.write('RESULT ' + JSON.stringify({
        ok: false,
        name: error?.name,
        code: error?.code,
        currentVersion: error?.currentVersion,
        message: error?.message,
      }) + '\\n')
    }
  `, 'utf8')
})

afterAll(async () => {
  if (previousEditorDir === undefined) delete process.env.POISE_EDITOR_DIR
  else process.env.POISE_EDITOR_DIR = previousEditorDir
  await rm(editorDir, { recursive: true, force: true })
  await rm(workerRoot, { recursive: true, force: true })
})

describe('editor file integrity', () => {
  it('cleans stale temp files before serving editor operations', async () => {
    expect(await readdir(editorDir)).not.toContain('orphan.md.tmp.123.456.1')
    expect(await readdir(editorDir)).toContain(recentTempName)
  })

  it('serializes overlapping document writes in invocation order', async () => {
    const writes = Array.from({ length: 20 }, (_, index) => (
      editor.writeDoc('rapid-doc', `# Revision ${index}\n${'x'.repeat(index)}`)
    ))

    await Promise.all(writes)
    const saved = await editor.readDoc('rapid-doc')
    expect(saved.content).toBe(`# Revision 19\n${'x'.repeat(19)}`)
    expect((await readdir(editorDir)).some((name) => name.startsWith('rapid-doc.md.tmp.'))).toBe(false)
  })

  it('serializes overlapping annotation writes in invocation order', async () => {
    const annotation = (index: number) => ({
      id: `annotation-${index}`,
      session_id: `session-${index}`,
      range: { start_line: 0, start_offset: 0, end_line: 0, end_offset: 1 },
      snippet: 'x',
      comment: `Revision ${index}`,
      created_at: '2026-07-10T00:00:00.000Z',
      updated_at: '2026-07-10T00:00:00.000Z',
    })
    const writes = Array.from({ length: 20 }, (_, index) => (
      editor.writeAnnotations('rapid-annotations', { annotations: [annotation(index)] })
    ))

    await Promise.all(writes)
    const saved = await editor.readAnnotations('rapid-annotations')
    expect(saved.annotations).toEqual([annotation(19)])
    expect(saved.version).toMatch(/^[a-f0-9]{64}$/)
  })

  it('makes document compare-and-swap atomic across Poise processes', async () => {
    const slug = 'cross-process-doc'
    const initial = await editor.writeDoc(slug, '# base')
    const blocker = new Database(join(editorDir, '.poise-editor-lock.sqlite3'), { timeout: 0 })
    blocker.exec('BEGIN IMMEDIATE')
    const jobs = [
      startEditorWorker({
        operation: 'doc',
        slug,
        content: '# process A',
        context: { clientId: 'process-a', revision: 1, baseVersion: initial.version },
      }),
      startEditorWorker({
        operation: 'doc',
        slug,
        content: '# process B',
        context: { clientId: 'process-b', revision: 1, baseVersion: initial.version },
      }),
    ]

    try {
      await Promise.all(jobs.map((job) => job.ready))
      await new Promise((resolve) => setTimeout(resolve, 150))
      await expect(editor.readDoc(slug)).resolves.toMatchObject({ content: '# base' })
    } finally {
      releaseBlocker(blocker)
    }

    const results = await Promise.all(jobs.map((job) => job.result))
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    const winner = results[0].ok ? 0 : 1
    const success = results[winner]
    const conflict = results[1 - winner]
    if (!success.ok || conflict.ok) throw new Error('expected one successful write and one conflict')
    expect(conflict).toMatchObject({
      name: 'EditorConflictError',
      code: 'EDITOR_CONFLICT',
      currentVersion: success.value.version,
    })
    await expect(editor.readDoc(slug)).resolves.toMatchObject({
      content: winner === 0 ? '# process A' : '# process B',
      version: success.value.version,
    })
    expect((await readdir(editorDir)).some((name) => name.startsWith(`${slug}.md.tmp.`))).toBe(false)
  }, 15_000)

  it('makes annotation compare-and-swap atomic across Poise processes', async () => {
    const slug = 'cross-process-annotations'
    const initial = await editor.writeAnnotations(slug, { annotations: [] })
    const annotation = (processName: string) => ({
      id: processName,
      session_id: processName,
      range: { start_line: 0, start_offset: 0, end_line: 0, end_offset: 1 },
      snippet: processName,
      comment: processName,
      created_at: '2026-07-10T00:00:00.000Z',
      updated_at: '2026-07-10T00:00:00.000Z',
    })
    const variants = [annotation('process-a'), annotation('process-b')]
    const blocker = new Database(join(editorDir, '.poise-editor-lock.sqlite3'), { timeout: 0 })
    blocker.exec('BEGIN IMMEDIATE')
    const jobs = variants.map((value, index) => startEditorWorker({
      operation: 'annotations',
      slug,
      annotations: { annotations: [value] },
      context: {
        clientId: `process-${index}`,
        revision: 1,
        baseVersion: initial.version,
      },
    }))

    try {
      await Promise.all(jobs.map((job) => job.ready))
      await new Promise((resolve) => setTimeout(resolve, 150))
      await expect(editor.readAnnotations(slug)).resolves.toMatchObject({ annotations: [] })
    } finally {
      releaseBlocker(blocker)
    }

    const results = await Promise.all(jobs.map((job) => job.result))
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    const winner = results[0].ok ? 0 : 1
    const success = results[winner]
    const conflict = results[1 - winner]
    if (!success.ok || conflict.ok) throw new Error('expected one successful write and one conflict')
    expect(conflict).toMatchObject({
      name: 'EditorConflictError',
      code: 'EDITOR_CONFLICT',
      currentVersion: success.value.version,
    })
    await expect(editor.readAnnotations(slug)).resolves.toMatchObject({
      annotations: [variants[winner]],
      version: success.value.version,
    })
    expect((await readdir(editorDir)).some((name) => (
      name.startsWith(`${slug}.annotations.json.tmp.`)
    ))).toBe(false)
  }, 15_000)

  it('fails closed when the process-shared mutation lock is unavailable', async () => {
    const slug = 'unavailable-lock'
    const lockPath = join(editorDir, '.poise-editor-lock.sqlite3')
    await editor.writeDoc(slug, '# preserved')
    await writeFile(lockPath, 'not a sqlite database', 'utf8')

    try {
      await expect(editor.writeDoc(slug, '# must not be written')).rejects.toMatchObject({
        name: 'EditorLockError',
        code: 'EDITOR_LOCK_UNAVAILABLE',
        statusCode: 503,
      })
      await expect(editor.readDoc(slug)).resolves.toMatchObject({ content: '# preserved' })
    } finally {
      await rm(lockPath, { force: true })
    }
  })

  it('rejects late stale client revisions for documents and annotations', async () => {
    const initialDoc = await editor.writeDoc('revisioned', '# initial')
    const docContext = { clientId: 'client-a', baseVersion: initialDoc.version }
    await editor.writeDoc('revisioned', '# newest', { ...docContext, revision: 2 })
    const staleDoc = await editor.writeDoc('revisioned', '# stale', { ...docContext, revision: 1 })
    expect(staleDoc.stale).toBe(true)
    await expect(editor.readDoc('revisioned')).resolves.toMatchObject({ content: '# newest' })

    const newest = {
      id: 'newest', session_id: 'newest',
      range: { start_line: 0, start_offset: 0, end_line: 0, end_offset: 1 },
      snippet: 'n', comment: 'newest',
      created_at: '2026-07-10T00:00:00.000Z', updated_at: '2026-07-10T00:00:00.000Z',
    }
    const initialAnnotations = await editor.readAnnotations('revisioned')
    const annotationsContext = { clientId: 'client-a', baseVersion: initialAnnotations.version }
    await editor.writeAnnotations(
      'revisioned',
      { annotations: [newest] },
      { ...annotationsContext, revision: 2 },
    )
    const staleAnnotations = await editor.writeAnnotations(
      'revisioned',
      { annotations: [] },
      { ...annotationsContext, revision: 1 },
    )
    expect(staleAnnotations.stale).toBe(true)
    await expect(editor.readAnnotations('revisioned')).resolves.toMatchObject({ annotations: [newest] })
  })

  it('orders deletion after an already accepted write', async () => {
    const write = editor.writeDoc('delete-race', '# transient')
    const remove = editor.deleteDoc('delete-race')
    await Promise.all([write, remove])

    await expect(editor.readDoc('delete-race')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps one chat session under concurrent creation', async () => {
    const sessions = await Promise.all(
      Array.from({ length: 10 }, () => editor.getOrCreateChatSession('chat-race')),
    )
    expect(new Set(sessions.map((session) => session.session_id))).toHaveLength(1)
  })

  it('rejects oversized UTF-8 documents without replacing existing data', async () => {
    await editor.writeDoc('size-limit', '# safe')
    const oversized = '€'.repeat(Math.floor(editor.MAX_DOC_BYTES / 3) + 1)

    await expect(editor.writeDoc('size-limit', oversized)).rejects.toThrow('doc too large')
    await expect(editor.readDoc('size-limit')).resolves.toMatchObject({ content: '# safe' })
  })

  it('bounds reads of externally oversized documents', async () => {
    await writeFile(join(editorDir, 'external-oversized.md'), 'x'.repeat(editor.MAX_DOC_BYTES + 1), 'utf8')
    await expect(editor.readDoc('external-oversized')).rejects.toThrow('doc too large')
    await expect(editor.listDocs()).resolves.toContainEqual(expect.objectContaining({
      slug: 'external-oversized',
      size: editor.MAX_DOC_BYTES + 1,
    }))
  })

  it('rejects oversized annotations without replacing existing data', async () => {
    await editor.writeAnnotations('annotation-limit', { annotations: [] })
    const oversized = {
      id: 'large',
      session_id: 'large',
      range: { start_line: 0, start_offset: 0, end_line: 0, end_offset: 1 },
      snippet: 'x',
      comment: 'x'.repeat(editor.MAX_ANNOTATIONS_BYTES),
      created_at: '2026-07-10T00:00:00.000Z',
      updated_at: '2026-07-10T00:00:00.000Z',
    }

    await expect(
      editor.writeAnnotations('annotation-limit', { annotations: [oversized] }),
    ).rejects.toThrow('annotations too large')
    await expect(editor.readAnnotations('annotation-limit')).resolves.toMatchObject({ annotations: [] })
  })

  it('returns SHA-256 versions from document and annotation reads and writes', async () => {
    const doc = await editor.writeDoc('versioned-content', '# versioned')
    expect(doc.version).toBe(createHash('sha256').update('# versioned').digest('hex'))
    await expect(editor.readDoc('versioned-content')).resolves.toMatchObject({ version: doc.version })

    const missing = await editor.readAnnotations('versioned-content')
    expect(missing.version).toMatch(/^[a-f0-9]{64}$/)
    const annotations = await editor.writeAnnotations('versioned-content', { annotations: [] })
    expect(annotations.version).toMatch(/^[a-f0-9]{64}$/)
    expect(annotations.version).not.toBe(missing.version)
    await expect(editor.readAnnotations('versioned-content')).resolves.toMatchObject({
      version: annotations.version,
    })
  })

  it('prevents multi-tab document overwrites while allowing an uninterrupted client chain', async () => {
    const initial = await editor.writeDoc('multi-tab-doc', '# base')
    const tabA = await editor.writeDoc('multi-tab-doc', '# tab A one', {
      clientId: 'tab-a', revision: 1, baseVersion: initial.version,
    })

    await expect(editor.writeDoc('multi-tab-doc', '# tab B stale', {
      clientId: 'tab-b', revision: 1, baseVersion: initial.version,
    })).rejects.toMatchObject({
      name: 'EditorConflictError',
      code: 'EDITOR_CONFLICT',
      statusCode: 409,
      currentVersion: tabA.version,
    })

    const tabASecond = await editor.writeDoc('multi-tab-doc', '# tab A two', {
      clientId: 'tab-a', revision: 2, baseVersion: initial.version,
    })
    expect(tabASecond.stale).toBeUndefined()

    const tabB = await editor.writeDoc('multi-tab-doc', '# tab B current', {
      clientId: 'tab-b', revision: 2, baseVersion: tabASecond.version,
    })
    await expect(editor.writeDoc('multi-tab-doc', '# tab A stale chain', {
      clientId: 'tab-a', revision: 3, baseVersion: initial.version,
    })).rejects.toBeInstanceOf(editor.EditorConflictError)

    const lateLowerRevision = await editor.writeDoc('multi-tab-doc', '# late lower', {
      clientId: 'tab-a', revision: 1, baseVersion: initial.version,
    })
    expect(lateLowerRevision).toMatchObject({ stale: true, version: tabB.version })
    await expect(editor.readDoc('multi-tab-doc')).resolves.toMatchObject({ content: '# tab B current' })
  })

  it('prevents multi-tab annotation overwrites', async () => {
    const initial = await editor.readAnnotations('multi-tab-annotations')
    const tabA = await editor.writeAnnotations('multi-tab-annotations', { annotations: [] }, {
      clientId: 'annotations-a', revision: 1, baseVersion: initial.version,
    })
    await expect(editor.writeAnnotations('multi-tab-annotations', { annotations: [] }, {
      clientId: 'annotations-b', revision: 1, baseVersion: initial.version,
    })).rejects.toMatchObject({
      name: 'EditorConflictError',
      currentVersion: tabA.version,
    })
  })

  it('rejects malformed annotation containers instead of treating them as empty', async () => {
    for (const [slug, body] of [
      ['annotations-missing-key', '{}'],
      ['annotations-non-array', '{"annotations":{}}'],
      ['annotations-null', 'null'],
    ]) {
      await writeFile(join(editorDir, `${slug}.annotations.json`), body, 'utf8')
      await expect(editor.readAnnotations(slug)).rejects.toThrow('annotations must be an array')
    }
  })
})

describe('editor document slugs', () => {
  it('rejects aliases and filters noncanonical external files', async () => {
    const truncatedTarget = 'a'.repeat(editor.MAX_SLUG_LENGTH)
    await editor.writeDoc('collision_slug', '# canonical')
    await editor.writeDoc(truncatedTarget, '# max length')

    await expect(editor.writeDoc('collision slug', '# alias')).rejects.toThrow('invalid slug')
    await expect(editor.writeDoc('nested/collision_slug', '# path alias')).rejects.toThrow('invalid slug')
    await expect(editor.writeDoc(`${truncatedTarget}b`, '# truncation alias')).rejects.toThrow('invalid slug')
    await expect(editor.readDoc('collision_slug')).resolves.toMatchObject({ content: '# canonical' })
    await expect(editor.readDoc(truncatedTarget)).resolves.toMatchObject({ content: '# max length' })

    await writeFile(join(editorDir, 'not canonical.md'), '# hidden from list', 'utf8')
    await writeFile(join(editorDir, '.leading-dot.md'), '# hidden from list', 'utf8')
    await writeFile(join(editorDir, `${'z'.repeat(editor.MAX_SLUG_LENGTH + 1)}.md`), '# hidden from list', 'utf8')
    const listed = (await editor.listDocs()).map((doc) => doc.slug)
    expect(listed).not.toContain('not canonical')
    expect(listed).not.toContain('.leading-dot')
    expect(listed).not.toContain('z'.repeat(editor.MAX_SLUG_LENGTH + 1))
  })

  it('remain sortable while resisting same-tick collisions', () => {
    const slugs = Array.from({ length: 2_000 }, () => editor.newSlug())
    expect(new Set(slugs)).toHaveLength(slugs.length)
    for (const slug of slugs) {
      expect(slug).toMatch(/^untitled-\d{17}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    }
  })
})
