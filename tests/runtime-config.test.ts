import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertSecureDotenv, loadSecureDotenv, validateConfabUrl } from '../server/runtime-config'

let root = ''

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = ''
})

describe('runtime configuration security', () => {
  it('allows loopback HTTP and requires HTTPS for remote Confab hosts', () => {
    expect(validateConfabUrl('http://127.0.0.1:8000')).toBe('http://127.0.0.1:8000/')
    expect(validateConfabUrl('http://[::1]:8000')).toBe('http://[::1]:8000/')
    expect(validateConfabUrl('https://confab.example')).toBe('https://confab.example/')
    expect(() => validateConfabUrl('http://confab.example')).toThrow(/must use HTTPS/)
    expect(() => validateConfabUrl('https://token@confab.example')).toThrow(/must not contain credentials/)
  })

  it.runIf(process.platform !== 'win32')('rejects a production .env readable by group or others', async () => {
    root = await mkdtemp(join(tmpdir(), 'poise-runtime-config-test-'))
    const path = join(root, '.env')
    await writeFile(path, 'CONFAB_API_KEY=secret\n', { mode: 0o644 })
    await expect(assertSecureDotenv(root)).rejects.toThrow(/chmod 600/)

    await chmod(path, 0o600)
    await expect(assertSecureDotenv(root)).resolves.toBeUndefined()
  })

  it('rejects a non-file .env before loading', async () => {
    root = await mkdtemp(join(tmpdir(), 'poise-runtime-config-test-'))
    await mkdir(join(root, '.env'))
    await expect(loadSecureDotenv(root)).rejects.toThrow('.env must be a regular file')
  })

  it.runIf(process.platform !== 'win32')('validates .env permissions before loading its values', async () => {
    root = await mkdtemp(join(tmpdir(), 'poise-runtime-config-test-'))
    const path = join(root, '.env')
    const key = 'POISE_SECURE_DOTENV_ORDER_TEST'
    const previous = process.env[key]
    delete process.env[key]
    await writeFile(path, `${key}=loaded\n`, { mode: 0o644 })

    try {
      await expect(loadSecureDotenv(root)).rejects.toThrow(/chmod 600/)
      expect(process.env[key]).toBeUndefined()

      await chmod(path, 0o600)
      await expect(loadSecureDotenv(root)).resolves.toBeUndefined()
      expect(process.env[key]).toBe('loaded')
    } finally {
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    }
  })
})
