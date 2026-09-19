// The legacy updater yields to the separately installed release controller.
import { request } from 'node:http'
import { readFile, lstat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function selfUpdateRoot(home = homedir()) {
  return process.env.POISE_SELF_UPDATE_ROOT || join(home, '.poise', 'self-update')
}
export async function selfUpdateEnabled(root = selfUpdateRoot()) {
  const path = join(root, 'config.json')
  let info
  try { info = await lstat(path) } catch (error) { if (error.code === 'ENOENT' && !(await hasControllerInstallation(root))) return false; throw new Error('Managed controller configuration unavailable') }
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)
      || (process.getuid && info.uid !== process.getuid())) throw new Error('Unsafe self-update configuration; legacy promotion is blocked')
  const config = JSON.parse(await readFile(path, 'utf8'))
  if (config.enabled !== true && await hasControllerInstallation(root)) throw new Error('Managed controller requires maintenance')
  return config.enabled === true
}

export function supervisorRequest(root, method, path, body = undefined) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const req = request({ socketPath: join(root, 'control.sock'), method, path,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} }, res => {
      const chunks = []; let bytes = 0
      res.on('data', chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) res.destroy(new Error('Controller response too large')); else chunks.push(chunk) })
      res.on('error', reject)
      res.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (!res.statusCode || res.statusCode >= 400) reject(new Error(value.error || 'Controller request failed'))
          else resolve(value)
        } catch (error) { reject(error) }
      })
    })
    const timer = setTimeout(() => req.destroy(new Error('Controller is unavailable; legacy promotion remains blocked')), 8000)
    req.on('error', reject); req.on('close', () => clearTimeout(timer))
    req.end(data)
  })
}

export async function hasControllerInstallation(root) {
  try { await lstat(join(root, 'installed.json')); return true }
  catch (error) { if (error.code === 'ENOENT') return false; throw error }
}
