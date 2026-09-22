import Database from 'better-sqlite3'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { withProcessLock } from '../server/process-lock'

it('releases an empty reservation without falsely failing an already committed file write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'poise-lock-release-'))
  const path = join(root, 'lock.sqlite3')
  let observer: InstanceType<typeof Database> | undefined
  try {
    const result = withProcessLock({ path }, async () => {
      observer = new Database(path, { timeout: 0 })
      observer.exec('BEGIN')
      observer.prepare('SELECT name FROM sqlite_master').all()
      await writeFile(join(root, 'saved.txt'), 'durable result')
      return 'saved'
    })
    await expect(result).resolves.toBe('saved')
    expect(await readFile(join(root, 'saved.txt'), 'utf8')).toBe('durable result')
    await expect(withProcessLock({ path }, async () => 'next writer')).resolves.toBe('next writer')
  } finally {
    if (observer?.inTransaction) observer.exec('ROLLBACK')
    observer?.close()
    await rm(root, { recursive: true, force: true })
  }
})
