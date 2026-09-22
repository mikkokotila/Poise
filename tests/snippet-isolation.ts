import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

const root = mkdtempSync(join(tmpdir(), 'poise-snippet-isolation-'))
process.env.POISE_ESPANSO_MATCH_DIR = root
afterAll(() => { rmSync(root, { recursive: true, force: true }) })
