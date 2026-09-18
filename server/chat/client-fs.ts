// The client side of ACP that Poise serves for agents that ask it to
// (Grok's `fs/read_text_file` and `fs/write_text_file`). Every path is
// resolved inside the session's checkout with the same rules as revert:
// no traversal, no symlink escape, nothing under `.git`, bounded sizes.
//
// Poise deliberately does not advertise the ACP terminal capability. A
// working directory is not confinement — a shell command escapes it with a
// single `cd` — and a capability Poise cannot enforce is one it must not
// claim. Agents run commands themselves under their own sandboxes and
// permission prompts, and their output still reaches the transcript through
// the tool-call updates they stream.

import { constants } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import { PathError, resolveInsideCheckout, writeFileAtomic } from './git'

export const CLIENT_FILE_MAX_BYTES = 8 * 1024 * 1024

/** Read a regular file inside the checkout, bounded. Non-blocking open: a
 *  FIFO or device is refused, not waited on; a symlink is not followed. The
 *  read is capped at the bound plus one byte, never the file's own size. */
export async function readCheckoutBytes(checkout: string, path: string, maxBytes = CLIENT_FILE_MAX_BYTES): Promise<{ relative: string, bytes: Buffer }> {
  const { absolute, relative } = await resolveInsideCheckout(checkout, path)
  let handle
  try {
    handle = await open(absolute, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0))
  } catch (error: any) {
    throw new PathError(`cannot read ${relative}: ${error?.code === 'ENOENT' ? 'no such file' : error?.message || error}`)
  }
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new PathError(`${relative} is not a regular file`)
    if (info.size > maxBytes) throw new PathError(`${relative} exceeds ${maxBytes} bytes`)
    const capped = Buffer.alloc(maxBytes + 1)
    let offset = 0
    while (offset < capped.byteLength) {
      const { bytesRead } = await handle.read(capped, offset, capped.byteLength - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset > maxBytes) throw new PathError(`${relative} exceeds ${maxBytes} bytes`)
    return { relative, bytes: capped.subarray(0, offset) }
  } finally {
    await handle.close()
  }
}

export async function readCheckoutTextFile(checkout: string, path: string, options: { line?: number, limit?: number } = {}): Promise<string> {
  const { bytes } = await readCheckoutBytes(checkout, path)
  const text = bytes.toString('utf8')
  if (options.line === undefined && options.limit === undefined) return text
  const lines = text.split('\n')
  const start = Math.max(1, Math.floor(options.line ?? 1)) - 1
  const count = options.limit === undefined ? lines.length - start : Math.max(0, Math.floor(options.limit))
  return lines.slice(start, start + count).join('\n')
}

export async function writeCheckoutTextFile(checkout: string, path: string, content: string): Promise<void> {
  if (typeof content !== 'string') throw new PathError('content must be a string')
  if (Buffer.byteLength(content, 'utf8') > CLIENT_FILE_MAX_BYTES) throw new PathError(`content exceeds ${CLIENT_FILE_MAX_BYTES} bytes`)
  const { absolute } = await resolveInsideCheckout(checkout, path)
  await mkdir(dirname(absolute), { recursive: true })
  await writeFileAtomic(absolute, content)
}
