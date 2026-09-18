// Editor documents live under ~/.poise/editor (or POISE_EDITOR_DIR), not in
// any repository checkout, while a chat session's agent can only touch its
// checkout. Rather than relocate documents or let agents reach outside the
// checkout, a session with document context gets a *staged copy* inside the
// checkout under `.poise-chat/docs/<sessionId>/` (excluded from git). The
// agent edits the copy; after each turn the copy is written back through the
// Editor's own versioned write API, so a document that moved in the Editor
// meanwhile is a reported conflict, never a clobber — the same contract the
// Editor's autosave lives by. Before each turn the copy is refreshed from the
// Editor when the Editor moved and the copy is untouched.
//
// The copy belongs to exactly one session: its path carries the session id,
// so two sessions on the same document in one checkout never share a file,
// deleting one session never touches another's copy, and a fork gets its own
// copy (taken from the source's stage, with provenance) rather than a shared
// one. A copy that cannot be read (a symlink, a directory, a FIFO, an
// oversized file, a permission error) is reported as such and left alone;
// only a genuinely absent file counts as missing.

import { constants } from 'node:fs'
import { mkdir, open, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { EditorConflictError, MAX_DOC_BYTES, isCanonicalSlug, readDoc, writeDoc, type EditorVersion } from '../editor'
import { resolveInsideCheckout, writeFileAtomic } from './git'
import type { StagedDocument } from './protocol'

export type { StagedDocument }

export const STAGED_DOCS_DIR = '.poise-chat/docs'

export type BridgeReport =
  | { kind: 'staged', path: string }
  | { kind: 'refreshed', path: string }
  | { kind: 'unchanged' }
  | { kind: 'written-back', version: EditorVersion }
  | { kind: 'conflict', message: string }
  | { kind: 'missing', message: string }
  | { kind: 'unreadable', message: string }

/** Reports the runtime surfaces to the user as errors. */
export function isBridgeProblem(report: BridgeReport): report is Extract<BridgeReport, { message: string }> {
  return report.kind === 'conflict' || report.kind === 'missing' || report.kind === 'unreadable'
}

function hashOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

// Session ids are UUIDs; anything else is refused rather than joined into a path.
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

/** Checkout-relative directory holding one session's staged copies. */
export function sessionStageDir(sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error('invalid session id')
  return `${STAGED_DOCS_DIR}/${sessionId}`
}

function stagedPath(sessionId: string, slug: string): string {
  if (!isCanonicalSlug(slug)) throw new Error('invalid document slug')
  return `${sessionStageDir(sessionId)}/${slug}.md`
}

async function writeStaged(checkout: string, path: string, content: string): Promise<void> {
  const { absolute } = await resolveInsideCheckout(checkout, path)
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 })
  await writeFileAtomic(absolute, content)
}

/** Copy the Editor document into the checkout as this session's own stage. */
export async function stageDocument(checkout: string, sessionId: string, slug: string): Promise<StagedDocument> {
  const path = stagedPath(sessionId, slug)
  const doc = await readDoc(slug)
  await writeStaged(checkout, path, doc.content)
  return { slug, path, baseVersion: doc.version, stagedHash: hashOf(doc.content), revision: 0 }
}

/** A fork's stage: the source's current copy when there is one on disk (with
 *  the source's base version and untouched-hash kept, so an edit pending in
 *  the source is still an edit here and a conflict there is a conflict here),
 *  otherwise a fresh copy of the Editor document. The source's copy is read,
 *  never moved or shared. A source copy that cannot be read fails the fork
 *  with the reason rather than quietly staging something else. */
export async function forkStagedDocument(checkout: string, forkSessionId: string, slug: string, source: { sessionId: string, staged: StagedDocument | null | undefined }): Promise<StagedDocument> {
  const path = stagedPath(forkSessionId, slug)
  if (source.staged && source.staged.slug === slug) {
    const current = await readStaged(checkout, source.staged)
    if (current.kind === 'unreadable') throw new Error(`the source session's staged copy could not be taken over: ${current.message}`)
    if (current.kind === 'present') {
      await writeStaged(checkout, path, current.content)
      return {
        slug,
        path,
        baseVersion: source.staged.baseVersion,
        stagedHash: source.staged.stagedHash,
        revision: 0,
        provenance: { fromSession: source.sessionId },
      }
    }
  }
  return stageDocument(checkout, forkSessionId, slug)
}

type StagedRead =
  | { kind: 'present', content: string }
  | { kind: 'missing' }
  | { kind: 'unreadable', message: string }

/** Read the staged copy with the same rules as every other checkout read:
 *  resolved inside the checkout, no symlink followed, regular files only,
 *  bounded size, non-blocking open. Only ENOENT is absence; every other
 *  failure is reported so the copy is neither overwritten nor written back. */
async function readStaged(checkout: string, staged: StagedDocument): Promise<StagedRead> {
  let absolute: string
  try {
    ({ absolute } = await resolveInsideCheckout(checkout, staged.path))
  } catch (error) {
    return { kind: 'unreadable', message: `the staged copy ${staged.path} cannot be resolved: ${error instanceof Error ? error.message : String(error)}` }
  }
  let handle
  try {
    handle = await open(absolute, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0))
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'unreadable', message: `the staged copy ${staged.path} cannot be opened: ${error?.message || error}` }
  }
  try {
    const info = await handle.stat()
    if (!info.isFile()) return { kind: 'unreadable', message: `the staged copy ${staged.path} is not a regular file` }
    if (info.size > MAX_DOC_BYTES) return { kind: 'unreadable', message: `the staged copy ${staged.path} exceeds ${MAX_DOC_BYTES} bytes` }
    const capped = Buffer.alloc(MAX_DOC_BYTES + 1)
    let offset = 0
    while (offset < capped.byteLength) {
      const { bytesRead } = await handle.read(capped, offset, capped.byteLength - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset > MAX_DOC_BYTES) return { kind: 'unreadable', message: `the staged copy ${staged.path} exceeds ${MAX_DOC_BYTES} bytes` }
    return { kind: 'present', content: capped.subarray(0, offset).toString('utf8') }
  } catch (error: any) {
    return { kind: 'unreadable', message: `the staged copy ${staged.path} cannot be read: ${error?.message || error}` }
  } finally {
    await handle.close()
  }
}

/** Before a turn: bring the copy up to date with the Editor when the Editor
 *  moved and the agent has not touched the copy. Both moved → conflict. A
 *  copy that is gone is staged again (there is nothing of the agent's to
 *  keep); a copy that cannot be read is reported and left alone. */
export async function refreshDocument(checkout: string, staged: StagedDocument): Promise<BridgeReport> {
  let doc
  try { doc = await readDoc(staged.slug) } catch (error: any) {
    if (error?.code === 'ENOENT') return { kind: 'missing', message: `document ${staged.slug} no longer exists in the Editor; the staged copy at ${staged.path} stays as it is` }
    throw error
  }
  const current = await readStaged(checkout, staged)
  if (current.kind === 'unreadable') return { kind: 'unreadable', message: `${current.message}; it was left alone` }
  if (current.kind === 'missing') {
    await writeStaged(checkout, staged.path, doc.content)
    staged.baseVersion = doc.version
    staged.stagedHash = hashOf(doc.content)
    return { kind: 'staged', path: staged.path }
  }
  if (doc.version === staged.baseVersion) return { kind: 'unchanged' }
  if (hashOf(current.content) !== staged.stagedHash) {
    return { kind: 'conflict', message: `document ${staged.slug} changed in the Editor and the agent's copy at ${staged.path} also changed; the copy was left alone — merge by hand` }
  }
  await writeStaged(checkout, staged.path, doc.content)
  staged.baseVersion = doc.version
  staged.stagedHash = hashOf(doc.content)
  return { kind: 'refreshed', path: staged.path }
}

/** After a turn: write an edited copy back through the Editor's versioned
 *  API. A version mismatch is reported, not forced. */
export async function writeBackDocument(checkout: string, staged: StagedDocument, sessionId: string): Promise<BridgeReport> {
  const current = await readStaged(checkout, staged)
  if (current.kind === 'unreadable') return { kind: 'unreadable', message: `${current.message}; nothing written back` }
  if (current.kind === 'missing') return { kind: 'missing', message: `the staged copy ${staged.path} was deleted; nothing written back` }
  if (hashOf(current.content) === staged.stagedHash) return { kind: 'unchanged' }
  staged.revision += 1
  try {
    const result = await writeDoc(staged.slug, current.content, {
      clientId: `chat-${sessionId}`,
      revision: staged.revision,
      baseVersion: staged.baseVersion,
    })
    staged.baseVersion = result.version
    staged.stagedHash = hashOf(current.content)
    return { kind: 'written-back', version: result.version }
  } catch (error) {
    if (error instanceof EditorConflictError) {
      return { kind: 'conflict', message: `document ${staged.slug} changed in the Editor since it was staged; the agent's version is kept at ${staged.path} and was not written back` }
    }
    throw error
  }
}

/** Remove one session's own stage directory — only that directory, so a
 *  copy another session keeps (conflicted or not) is never touched. */
export async function unstageDocument(checkout: string, sessionId: string): Promise<void> {
  try {
    const { absolute } = await resolveInsideCheckout(checkout, sessionStageDir(sessionId))
    await rm(absolute, { recursive: true, force: true })
  } catch { /* already gone */ }
}

export function stagedDocumentPrompt(staged: StagedDocument, title: string): string {
  return [
    `[Document: "${title}" from the Poise Editor is staged at ${join(staged.path)} inside this checkout.]`,
    'Edit that file in place when the user asks for changes to the document; Poise writes it back to the Editor after each turn and reports conflicts. Do not commit it.',
  ].join('\n')
}
