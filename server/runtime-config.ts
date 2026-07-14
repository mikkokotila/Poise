import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { config as loadDotenv } from 'dotenv'

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1'
}

export function validateConfabUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('CONFAB_URL must be a valid absolute URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('CONFAB_URL must use HTTP or HTTPS')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('CONFAB_URL must not contain credentials, a query, or a fragment')
  }
  if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) {
    throw new Error('non-loopback CONFAB_URL values must use HTTPS')
  }
  return url.toString()
}

export async function assertSecureDotenv(cwd: string = process.cwd()): Promise<void> {
  const path = resolve(cwd, '.env')
  let fileStat
  try {
    fileStat = await stat(path)
  } catch (error: any) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  if (!fileStat.isFile()) throw new Error('.env must be a regular file')
  if (process.platform === 'win32') return
  const permissions = fileStat.mode & 0o777
  if ((permissions & 0o077) !== 0) {
    throw new Error(`.env permissions are ${permissions.toString(8)}; run: chmod 600 .env`)
  }
}

export async function loadSecureDotenv(cwd: string = process.cwd()): Promise<void> {
  await assertSecureDotenv(cwd)
  const result = loadDotenv({ path: resolve(cwd, '.env'), quiet: true })
  if (result.error && (result.error as NodeJS.ErrnoException).code !== 'ENOENT') {
    throw result.error
  }
}
