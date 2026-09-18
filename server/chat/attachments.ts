// Attachments a user drops into the composer are files the runtime stages
// inside the session's checkout under `.poise-chat/attachments/<sessionId>/`
// (excluded from git through `.git/info/exclude`). The runtime writes them
// under the checkout lease and records each one; at prompt time the record
// is what is trusted — the browser's copy of a path, size or text is never.

import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CHAT_LIMITS } from './protocol'

export const ATTACHMENT_DIR = '.poise-chat/attachments'

export interface AttachmentRecord {
  id: string
  sessionId: string
  name: string
  /** Checkout-relative path. */
  path: string
  size: number
  sha256: string
  createdAt: string
}

/** The name an uploaded file is stored under: one path component, ASCII. */
export function safeAttachmentName(raw: string): string {
  const base = raw.replace(/^.*[\\/]/, '').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_')
  return base.slice(0, 120) || 'attachment'
}

export function attachmentPath(sessionId: string, id: string, name: string): string {
  return `${ATTACHMENT_DIR}/${sessionId}/${id}-${name}`
}

export function sha256Of(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex')
}

/** Inline text for a small text file, or nothing for binary/large ones. */
export function inlineText(body: Buffer): string | undefined {
  if (body.byteLength > CHAT_LIMITS.inlineAttachmentBytes) return undefined
  const sample = body.subarray(0, 8_192)
  for (const byte of sample) if (byte === 0) return undefined
  return body.toString('utf8')
}

/** Keep `.poise-chat/` out of git without touching tracked ignore files. */
export async function ensureExcluded(checkout: string): Promise<void> {
  const exclude = join(checkout, '.git', 'info', 'exclude')
  try {
    const current = await readFile(exclude, 'utf8').catch(() => '')
    if (!current.split('\n').includes('.poise-chat/')) {
      await mkdir(join(checkout, '.git', 'info'), { recursive: true })
      await appendFile(exclude, `${current.endsWith('\n') || !current ? '' : '\n'}.poise-chat/\n`)
    }
  } catch { /* not a git checkout: attachments are plain files then */ }
}
