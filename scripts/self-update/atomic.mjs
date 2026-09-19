// Durable filesystem primitives. Every record the controller relies on after
// a crash goes through here: write to a sibling temporary file, fsync it,
// rename over the target, fsync the directory. A reader therefore sees either
// the previous complete document or the new one, never a torn write.
import { constants } from 'node:fs'
import { chmod, mkdir, open, readFile, rename, rm, stat, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  // mkdir's mode is masked by the umask and ignored for existing directories.
  await chmod(path, 0o700)
}

async function fsyncDirectory(path) {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY)
    await handle.sync()
  } catch {
    // Some filesystems refuse to fsync a directory; the file fsync above still
    // holds and the rename is atomic regardless.
  } finally {
    await handle?.close()
  }
}

export async function writeFileAtomic(path, content, { mode = 0o600 } = {}) {
  const directory = dirname(path)
  const staged = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  const handle = await open(staged, 'w', mode)
  try {
    await handle.writeFile(content)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await chmod(staged, mode)
    await rename(staged, path)
  } catch (error) {
    await rm(staged, { force: true })
    throw error
  }
  await fsyncDirectory(directory)
}

export async function writeJsonAtomic(path, value, options) {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, options)
}

export async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
}

export async function appendLineDurable(path, line, { mode = 0o600 } = {}) {
  const handle = await open(path, 'a', mode)
  try {
    await handle.writeFile(`${line}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

export async function isFile(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** A file only this user may read, owned by this user. */
export async function assertPrivateFile(path, label = path, { uid = process.getuid?.() } = {}) {
  let info
  try {
    info = await stat(path)
  } catch {
    throw new Error(`${label} does not exist`)
  }
  if (!info.isFile()) throw new Error(`${label} is not a regular file`)
  if ((info.mode & 0o077) !== 0) throw new Error(`${label} must be readable by its owner only (chmod 600)`)
  if (typeof uid === 'number' && info.uid !== uid) throw new Error(`${label} must be owned by the current user`)
  return info
}

function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * One controller per root. The lock file is created exclusively and records
 * the holder's PID; a stale lock (its holder no longer running) is reclaimed.
 * A live holder makes acquisition fail, so a second daemon or a CLI invoked
 * with --direct can never steal the active controller's lock.
 */
export async function acquireLock(path, { pid = process.pid, alive = processAlive } = {}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(path, 'wx', 0o600)
      try {
        await handle.writeFile(`${JSON.stringify({ pid, at: new Date().toISOString() })}\n`)
        await handle.sync()
      } finally {
        await handle.close()
      }
      return {
        path,
        pid,
        async release() {
          const current = await readJson(path, null)
          if (current?.pid === pid) await unlink(path).catch(() => {})
        },
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const holder = await readJson(path, null)
      // A live holder — including this very process, which must never hold
      // the lock twice — makes acquisition fail.
      if (holder && Number.isInteger(holder.pid) && alive(holder.pid)) {
        const busy = new Error(`another self-update controller (pid ${holder.pid}) holds ${path}`)
        busy.code = 'LOCKED'
        throw busy
      }
      await unlink(path).catch(() => {})
    }
  }
  throw new Error(`could not acquire ${path}`)
}
