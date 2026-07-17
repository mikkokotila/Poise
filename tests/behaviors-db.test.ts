import Database from 'better-sqlite3'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

let tempRoot = ''
let loaded: typeof import('../server/db') | null = null

async function loadIsolatedDb(path: string): Promise<typeof import('../server/db')> {
  process.env.POISE_DB = path
  vi.resetModules()
  loaded = await import('../server/db')
  return loaded
}

afterEach(async () => {
  if (loaded?.db.open) loaded.closeDatabase()
  loaded = null
  delete process.env.POISE_DB
  vi.resetModules()
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  tempRoot = ''
})

describe('behavior database lifecycle', () => {
  it('migrates legacy cards once, preserves content, and purges retired credentials', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'poise-db-test-'))
    const path = join(tempRoot, 'cache.db')
    const legacy = new Database(path)
    legacy.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta(key, value) VALUES ('github_token', 'preserve-me');
      CREATE TABLE pipe_cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        lane TEXT NOT NULL,
        position INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO pipe_cards(id, text, lane, position, created_at, updated_at)
      VALUES (7, 'legacy card', 'idea', 0, '2026-01-01', '2026-01-01');
      CREATE TABLE prs (id INTEGER PRIMARY KEY, payload TEXT);
      INSERT INTO prs(id, payload) VALUES (1, 'preserve-me');
      CREATE TABLE behavior_seen (
        key TEXT NOT NULL,
        target TEXT NOT NULL,
        seen_at TEXT NOT NULL,
        claim_id TEXT NOT NULL DEFAULT '',
        lease_until INTEGER,
        PRIMARY KEY (key, target)
      );
      INSERT INTO behavior_seen(key, target, seen_at, claim_id, lease_until)
      VALUES ('review-new-prs', 'owner/repo#9@legacy', '2026-01-01', 'legacy-owner', 1);
    `)
    legacy.close()

    const first = await loadIsolatedDb(path)
    const { db, getMeta } = first
    expect(db.prepare('SELECT text FROM current_cards WHERE id = 7').pluck().get())
      .toBe('legacy card')
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pipe_cards'").pluck().get())
      .toBe('pipe_cards')
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='prs'").pluck().get())
      .toBe('prs')
    expect(getMeta('github_token')).toBeNull()
    expect(getMeta('schema_secure_delete_rebuild_v1')).toBe('complete')
    expect(db.prepare(`
      SELECT claim_id, lease_until, launch_error FROM behavior_seen
      WHERE key = 'review-new-prs' AND target = 'owner/repo#9@legacy'
    `).get()).toEqual({
      claim_id: '',
      lease_until: null,
      launch_error: 'legacy in-flight claim retained to prevent duplicate launch',
    })
    expect(db.pragma('secure_delete', { simple: true })).toBe(1)
    expect((await stat(path)).mode & 0o777).toBe(0o600)

    // User deletion after migration is authoritative: a restart must not
    // resurrect the row from the deliberately preserved recovery table.
    db.prepare('DELETE FROM current_cards WHERE id = 7').run()

    first.closeDatabase()
    const reopened = await loadIsolatedDb(path)
    expect(reopened.db.prepare('SELECT count(*) FROM current_cards WHERE id = 7').pluck().get())
      .toBe(0)
    expect(reopened.db.prepare('SELECT count(*) FROM pipe_cards WHERE id = 7').pluck().get())
      .toBe(1)
  })

  it('releases only the failed target claim and closes idempotently', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'poise-db-test-'))
    const path = join(tempRoot, 'cache.db')
    const {
      claimSeen,
      claimSeenOwned,
      closeDatabase,
      completeSeenOwned,
      linkBehaviorLaunchCallOwned,
      listBehaviorLaunchClaims,
      markBehaviorLaunchIntentOwned,
      releaseSeen,
      releaseSeenOwned,
      renewSeenOwned,
      db,
    } = await loadIsolatedDb(path)

    expect(claimSeen('review-new-prs', 'repo#1@abc')).toBe(true)
    expect(claimSeen('review-new-prs', 'repo#1@abc')).toBe(false)
    releaseSeen('review-new-prs', 'repo#2@def')
    expect(claimSeen('review-new-prs', 'repo#1@abc')).toBe(false)
    releaseSeen('review-new-prs', 'repo#1@abc')
    expect(claimSeen('review-new-prs', 'repo#1@abc')).toBe(true)

    releaseSeen('review-new-prs', 'repo#1@abc')
    const owner = claimSeenOwned('review-new-prs', 'repo#1@abc')
    expect(owner).toEqual(expect.any(String))
    expect(releaseSeenOwned('review-new-prs', 'repo#1@abc', 'superseded-owner')).toBe(false)
    expect(claimSeen('review-new-prs', 'repo#1@abc')).toBe(false)
    expect(releaseSeenOwned('review-new-prs', 'repo#1@abc', owner!)).toBe(true)
    expect(claimSeen('review-new-prs', 'repo#1@abc')).toBe(true)

    releaseSeen('review-new-prs', 'repo#1@abc')
    const expiredOwner = claimSeenOwned('review-new-prs', 'repo#1@abc', 60_000)
    db.prepare('UPDATE behavior_seen SET lease_until = ? WHERE key = ? AND target = ?')
      .run(Date.now() - 1, 'review-new-prs', 'repo#1@abc')
    const recoveredOwner = claimSeenOwned('review-new-prs', 'repo#1@abc')
    expect(recoveredOwner).toEqual(expect.any(String))
    expect(recoveredOwner).not.toBe(expiredOwner)
    expect(completeSeenOwned('review-new-prs', 'repo#1@abc', expiredOwner!)).toBe(false)
    expect(completeSeenOwned('review-new-prs', 'repo#1@abc', recoveredOwner!)).toBe(true)
    expect(claimSeenOwned('review-new-prs', 'repo#1@abc')).toBeNull()

    const launchedTarget = 'owner/repo#2@def'
    const launchedOwner = claimSeenOwned('review-new-prs', launchedTarget, 60_000)
    expect(launchedOwner).toEqual(expect.any(String))
    const requestedAt = new Date().toISOString()
    const expectedHead = 'b'.repeat(40)
    expect(markBehaviorLaunchIntentOwned({
      key: 'review-new-prs',
      target: launchedTarget,
      claimId: launchedOwner!,
      launchBehavior: 'pr_review',
      repo: 'owner/repo',
      pr: 2,
      requestedAt,
      expectedHead,
      actor: 'bit-mis',
      source: 'poise:review-new-prs',
      correlationId: launchedOwner!,
    })).toBe(true)
    db.prepare('UPDATE behavior_seen SET lease_until = ? WHERE key = ? AND target = ?')
      .run(Date.now() - 1, 'review-new-prs', launchedTarget)
    expect(claimSeenOwned('review-new-prs', launchedTarget)).toBeNull()
    expect(listBehaviorLaunchClaims('review-new-prs')).toEqual([
      expect.objectContaining({
        target: launchedTarget,
        claimId: launchedOwner,
        launchBehavior: 'pr_review',
        launchRepo: 'owner/repo',
        launchPr: 2,
        launchRequestedAt: requestedAt,
        launchCallId: null,
        launchExpectedHead: expectedHead,
        launchActor: 'bit-mis',
        launchSource: 'poise:review-new-prs',
        launchCorrelationId: launchedOwner,
      }),
    ])
    expect(linkBehaviorLaunchCallOwned(
      'review-new-prs', launchedTarget, 'wrong-owner', 'a'.repeat(32),
    )).toBe(false)
    expect(linkBehaviorLaunchCallOwned(
      'review-new-prs', launchedTarget, launchedOwner!, 'A'.repeat(32),
    )).toBe(true)
    expect(renewSeenOwned('review-new-prs', launchedTarget, launchedOwner!, 60_000)).toBe(true)
    expect(claimSeenOwned('review-new-prs', launchedTarget)).toBeNull()
    expect(releaseSeenOwned('review-new-prs', launchedTarget, launchedOwner!)).toBe(true)

    closeDatabase()
    expect(db.open).toBe(false)
    expect(() => closeDatabase()).not.toThrow()
  })
})
