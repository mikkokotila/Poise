import { describe, expect, it } from 'vitest'
import { PENDING_CHANGE_KEY, isChangeId, parsePoiseCommand, readPendingChanges, reconcilePendingChanges, releaseChangeId, reserveChangeId } from '../src/self-update-command'
import {
  POLL_ACTIVE_MS, POLL_IDLE_MS, POLL_MAX_MS, isTerminal, nextPollDelay, parseBuildIdentity, parseChange, parseSelfUpdateStatus,
  revertTarget, selectChangeForSession, tabRunsChange,
} from '../src/self-update-state'
import { DRAFT_SNAPSHOT_KEY, buildDraftSnapshot, cleanDraft, parseDraftSnapshot, saveDraftSnapshot, takeDraftSnapshot } from '../src/self-update-drafts'
import { HEALTH_POLL_MAX_MS, HEALTH_POLL_MS, IDLE_BEFORE_RELOAD_MS, OBSERVATION_FRESH_MS, RELOADED_RELEASE_KEY, ReloadController, guardClass } from '../src/self-update-reload'
import type { SelfChange, SelfUpdateStatus } from '../src/self-update-types'
import { deployCardHtml } from '../src/views/chat-deploy-card'

// The browser half of the self-improvement workflow, minus the DOM: how a
// typed message becomes (or does not become) a change command, how the deploy
// card reads status, what a safe reload carries across, and when a tab may
// reload itself at all.

class MemoryStore {
  map = new Map<string, string>()
  failWrites = false
  getItem(k: string): string | null { return this.map.get(k) ?? null }
  setItem(k: string, v: string): void { if (this.failWrites) throw new Error('quota'); this.map.set(k, v) }
  removeItem(k: string): void { this.map.delete(k) }
}

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

function change(over: Partial<SelfChange> = {}): SelfChange {
  return {
    id: '11111111-1111-4111-8111-111111111111', sessionId: 'src', instance: 'poise-prod:db', request: 'Add a Stop button', title: 'Add a Stop button',
    repository: 'mikkokotila/Poise', branch: 'poise/change-1111', baseSha: SHA_A, state: 'implementing', createdAt: '2026-09-19T10:00:00.000Z', updatedAt: '2026-09-19T10:00:00.000Z',
    canRevert: false, ...over,
  }
}

function status(over: Partial<SelfUpdateStatus> = {}): SelfUpdateStatus {
  return { enabled: true, available: true, activeRelease: null, previousRelease: null, hold: null, changes: [], ...over }
}

describe('the typed entrypoint', () => {
  it('recognises /poise and Poise: at the start of a message only', () => {
    expect(parsePoiseCommand('/poise Add a Stop button')).toEqual({ request: 'Add a Stop button', form: 'slash' })
    expect(parsePoiseCommand('  /POISE   trim me  ')).toEqual({ request: 'trim me', form: 'slash' })
    expect(parsePoiseCommand('Poise: rename the menu\nand keep the icon')).toEqual({ request: 'rename the menu\nand keep the icon', form: 'prefix' })
    expect(parsePoiseCommand('/poise')).toEqual({ request: '', form: 'slash' })
    expect(parsePoiseCommand('Poise:')).toEqual({ request: '', form: 'prefix' })
  })

  it('never treats a mention of Poise, agent prose or a different command as the command', () => {
    expect(parsePoiseCommand('Please ask Poise: to do something')).toBeNull()
    expect(parsePoiseCommand('poise: lowercase prefix is ordinary text')).toBeNull()
    expect(parsePoiseCommand('/poised for launch')).toBeNull()
    expect(parsePoiseCommand('/poisex')).toBeNull()
    expect(parsePoiseCommand('I typed /poise in the middle')).toBeNull()
    expect(parsePoiseCommand('The assistant said: "/poise do it"')).toBeNull()
    expect(parsePoiseCommand('')).toBeNull()
  })

  it('reuses one change id per session and request until the server has answered for it', () => {
    const store = new MemoryStore()
    const first = reserveChangeId(store, 's1', 'Add a Stop button', 1_000)
    expect(isChangeId(first)).toBe(true)
    expect(reserveChangeId(store, 's1', 'Add a Stop button', 2_000)).toBe(first)
    // A different request or session is a different change.
    const other = reserveChangeId(store, 's1', 'Add a Stop button!', 2_000)
    expect(other).not.toBe(first)
    expect(reserveChangeId(store, 's2', 'Add a Stop button', 2_000)).not.toBe(first)
    // No expiry of its own: a week later the same request is still the same change.
    expect(reserveChangeId(store, 's1', 'Add a Stop button', 2_000 + 7 * 24 * 60 * 60_000)).toBe(first)
    // Another tab (same storage) sees the same reservation.
    const otherTab = new MemoryStore(); otherTab.map = store.map
    expect(reserveChangeId(otherTab, 's1', 'Add a Stop button')).toBe(first)
    releaseChangeId(store, first)
    expect(reserveChangeId(store, 's1', 'Add a Stop button', 3_000)).not.toBe(first)
    expect(store.map.has(PENDING_CHANGE_KEY)).toBe(true)
  })

  it('reconciles ids the server already lists and keeps the rest', () => {
    const store = new MemoryStore()
    const a = reserveChangeId(store, 's1', 'a')
    const b = reserveChangeId(store, 's1', 'b')
    expect(reconcilePendingChanges(store, [a.toUpperCase(), 'ffffffff-ffff-4fff-8fff-ffffffffffff'])).toEqual([a])
    expect(readPendingChanges(store).map((p) => p.changeId)).toEqual([b])
    expect(reconcilePendingChanges(store, [])).toEqual([])
    expect(reserveChangeId(store, 's1', 'b')).toBe(b)
  })

  it('survives unusable storage', () => {
    const store = new MemoryStore()
    store.failWrites = true
    expect(isChangeId(reserveChangeId(store, 's1', 'x'))).toBe(true)
    store.map.set(PENDING_CHANGE_KEY, '{not json')
    expect(isChangeId(reserveChangeId(store, 's1', 'x'))).toBe(true)
  })
})

describe('reading the status endpoint', () => {
  it('reads the contract shape and drops anything malformed', () => {
    const s = parseSelfUpdateStatus({
      enabled: true, available: true,
      activeRelease: { id: 'r2', sha: SHA_B, root: '/r/r2', createdAt: 'now', callerSha: 'c' },
      previousRelease: { id: 'r1', sha: SHA_A },
      hold: { changeId: 'c1', sha: SHA_B, reason: 'health failed' },
      changes: [change({ state: 'live', canRevert: true, releaseId: 'r2', prNumber: 12, prUrl: 'https://github.com/mikkokotila/Poise/pull/12' }), { id: 'bad', state: 'nope' }, null, 'x'],
      recoveryUrl: 'http://127.0.0.1:5556/',
    })!
    expect(s.changes).toHaveLength(1)
    expect(s.changes[0].prNumber).toBe(12)
    expect(s.activeRelease?.id).toBe('r2')
    expect(s.previousRelease?.root).toBe('')
    expect(s.hold?.reason).toBe('health failed')
    expect(s.recoveryUrl).toBe('http://127.0.0.1:5556/')
  })

  it('treats an older server answer as unavailable rather than an error', () => {
    expect(parseSelfUpdateStatus({})).toBeNull()
    expect(parseSelfUpdateStatus(null)).toBeNull()
    expect(parseSelfUpdateStatus('<html>')).toBeNull()
    expect(parseSelfUpdateStatus({ enabled: 'yes', available: true })).toBeNull()
    expect(parseChange({ id: 'x', state: 'implementing' })?.repository).toBe('mikkokotila/Poise')
    expect(parseChange({ id: '', state: 'implementing' })).toBeNull()
  })

  it('reads the build identity from health, only as a full SHA with a release', () => {
    expect(parseBuildIdentity({ status: 'ok' })).toBeNull()
    expect(parseBuildIdentity({ build: { sha: null, releaseId: null } })).toEqual({ sha: null, releaseId: null })
    expect(parseBuildIdentity({ build: { sha: 'abc', releaseId: 'r1' } })).toEqual({ sha: null, releaseId: 'r1' })
    expect(parseBuildIdentity({ build: { sha: SHA_A, releaseId: '' } })).toEqual({ sha: SHA_A, releaseId: null })
  })
})

describe('what the card shows', () => {
  it('shows only the session\'s own newest change: source, dedicated, or acknowledged locally', () => {
    const older = change({ id: '22222222-2222-4222-8222-222222222222', sessionId: 'src', updatedAt: '2026-09-19T09:00:00.000Z' })
    const newer = change({ sessionId: 'src', updatedAt: '2026-09-19T11:00:00.000Z' })
    const foreign = change({ id: '33333333-3333-4333-8333-333333333333', sessionId: 'other', updatedAt: '2026-09-19T12:00:00.000Z' })
    const all = [older, foreign, newer]
    expect(selectChangeForSession(all, 'src')?.id).toBe(newer.id)
    expect(selectChangeForSession(all, 'dedicated', newer.id)?.id).toBe(newer.id)
    expect(selectChangeForSession(all, 'dedicated', undefined, new Set([older.id]))?.id).toBe(older.id)
    expect(selectChangeForSession(all, 'nobody')).toBeNull()
    expect(selectChangeForSession(all, null)).toBeNull()
  })

  it('offers a rollback only for the live change whose release is the active one', () => {
    const live = change({ state: 'live', canRevert: true, releaseId: 'r2' })
    expect(revertTarget(live, status({ activeRelease: { id: 'r2', sha: SHA_B, root: '', createdAt: '', callerSha: '' } }))).toEqual({ changeId: live.id, expectedReleaseId: 'r2' })
    // A newer release supersedes: the old card cannot roll back the newer change.
    expect(revertTarget(live, status({ activeRelease: { id: 'r3', sha: SHA_A, root: '', createdAt: '', callerSha: '' } }))).toBeNull()
    expect(revertTarget({ ...live, canRevert: false }, status({ activeRelease: { id: 'r2', sha: SHA_B, root: '', createdAt: '', callerSha: '' } }))).toBeNull()
    expect(revertTarget({ ...live, state: 'reverting' }, status({ activeRelease: { id: 'r2', sha: SHA_B, root: '', createdAt: '', callerSha: '' } }))).toBeNull()
    expect(revertTarget({ ...live, releaseId: undefined }, status({ activeRelease: { id: 'r2', sha: SHA_B, root: '', createdAt: '', callerSha: '' } }))).toBeNull()
    // Neither a missing token (enabled false) nor an unavailable bridge hides it: a
    // revert restores retained local artifacts and needs no network or model.
    const st = status({ enabled: false, available: false, reason: 'release token missing', activeRelease: { id: 'r2', sha: SHA_B, root: '', createdAt: '', callerSha: '' } })
    expect(revertTarget(live, st)).toEqual({ changeId: live.id, expectedReleaseId: 'r2' })
    expect(deployCardHtml({ status: st, change: live, local: null, browserSha: SHA_A, reverting: false, revertNote: null, statusError: 'Could not read the update status' })).toContain('>Revert</button>')
  })

  it('compares the change\'s build with this tab\'s compiled SHA, never a checkout', () => {
    const live = change({ state: 'live', releaseId: 'r2', mergeSha: SHA_B })
    const st = status({ activeRelease: { id: 'r2', sha: SHA_B, root: '', createdAt: '', callerSha: '' } })
    expect(tabRunsChange(live, st, SHA_B)).toBe(true)
    expect(tabRunsChange(live, st, SHA_A)).toBe(false)
    expect(tabRunsChange(live, st, null)).toBeNull()
    expect(tabRunsChange(change(), status(), SHA_A)).toBeNull()
  })

  it('polls fast while a change moves, slowly otherwise, and backs off bounded on failure', () => {
    expect(nextPollDelay({ available: true, failed: false, moving: true, previous: POLL_IDLE_MS })).toBe(POLL_ACTIVE_MS)
    expect(nextPollDelay({ available: true, failed: false, moving: false, previous: POLL_ACTIVE_MS })).toBe(POLL_IDLE_MS)
    expect(nextPollDelay({ available: false, failed: false, moving: true, previous: POLL_ACTIVE_MS })).toBe(POLL_IDLE_MS)
    let d = POLL_ACTIVE_MS
    for (let i = 0; i < 10; i++) d = nextPollDelay({ available: true, failed: true, moving: true, previous: d })
    expect(d).toBe(POLL_MAX_MS)
    expect(isTerminal('live')).toBe(true)
    expect(isTerminal('verifying')).toBe(false)
  })

  it('renders every state, escapes the request, and binds the rollback to the exact release', () => {
    const base = { local: null, browserSha: SHA_A, reverting: false, revertNote: null, statusError: null }
    for (const state of ['implementing', 'checking', 'awaiting_ci', 'merging', 'merged', 'deploying', 'verifying', 'live', 'reverting', 'reverted', 'failed', 'blocked', 'superseded'] as const) {
      const html = deployCardHtml({ ...base, status: status(), change: change({ state, request: '<b>bold</b> & co' }) })
      expect(html).toContain(`data-state="${state}"`)
      expect(html).toContain('&lt;b&gt;bold&lt;/b&gt; &amp; co')
      expect(html).not.toContain('<b>bold</b>')
    }
    const live = change({ state: 'live', canRevert: true, releaseId: 'r2', mergeSha: SHA_B, prNumber: 7, prUrl: 'https://github.com/mikkokotila/Poise/pull/7', headSha: 'c'.repeat(40) })
    const st = status({ activeRelease: { id: 'r2', sha: SHA_B, root: '', createdAt: '', callerSha: '' }, recoveryUrl: 'http://127.0.0.1:5556/' })
    const html = deployCardHtml({ ...base, status: st, change: live })
    expect(html).toContain('href="https://github.com/mikkokotila/Poise/pull/7"')
    expect(html).toContain('PR #7')
    expect(html).toContain('<code>bbbbbbb</code>')
    expect(html).toContain('this tab runs <code>aaaaaaa</code>')
    expect(html).toContain(`data-change="${live.id}" data-release="r2"`)
    expect(html).toContain('View evidence')
    // Same change once this tab runs its build, and after the release moved on.
    expect(deployCardHtml({ ...base, status: st, change: live, browserSha: SHA_B })).toContain('running in this tab')
    expect(deployCardHtml({ ...base, status: status({ activeRelease: { id: 'r3', sha: SHA_A, root: '', createdAt: '', callerSha: '' } }), change: live })).not.toContain('chat-deploy-revert')
    // A javascript: PR link is text, not a link.
    expect(deployCardHtml({ ...base, status: st, change: { ...live, prUrl: 'javascript:alert(1)' } })).not.toContain('href="javascript')
    // Nothing at all without a change or a local request.
    expect(deployCardHtml({ ...base, status: st, change: null })).toBe('')
    expect(deployCardHtml({ ...base, status: null, change: null, local: { id: 'x', request: 'soon', sessionId: 's', startedAt: 0 } })).toContain('Starting')
  })
})

describe('the draft snapshot', () => {
  it('keeps every non-empty draft, the fresh console and the active session, without pending ids', () => {
    const snap = buildDraftSnapshot({
      fromSha: SHA_A,
      activeSessionId: 's1',
      fresh: { draft: { text: 'fresh words', attachments: [], mentions: [], mode: null }, modelIdentity: 'opus-5-high' },
      sessions: [
        ['s1', { text: 'hello', attachments: [{ id: 'a1', name: 'x.txt', path: '.poise-chat/x.txt', size: 3, text: 'abc' }], mentions: [{ path: 'src/main.ts' }], mode: 'review' }],
        ['s2', { text: '', attachments: [], mentions: [], mode: null }],
        ['pending-123', { text: 'never', attachments: [], mentions: [], mode: null }],
        ['s3', null],
      ],
    }, 5_000)
    expect(Object.keys(snap.sessions)).toEqual(['s1'])
    expect(snap.sessions.s1.attachments[0]).toEqual({ id: 'a1', name: 'x.txt', path: '.poise-chat/x.txt', size: 3, text: 'abc' })
    expect(snap.sessions.s1.mode).toBe('review')
    expect(snap.fresh).toEqual({ draft: { text: 'fresh words', attachments: [], mentions: [], mode: null }, modelIdentity: 'opus-5-high' })
    expect(snap.activeSessionId).toBe('s1')
    expect(buildDraftSnapshot({ fromSha: null, activeSessionId: 'pending-1', fresh: { draft: null, modelIdentity: null }, sessions: [] }).activeSessionId).toBeNull()
  })

  it('cannot carry a File: only server attachment records serialise', () => {
    const draft = cleanDraft({ text: 'x', attachments: [{ name: 'raw', size: 1 }, { id: 'ok', name: 'n', path: 'p', size: 1 }], mentions: [{ path: 'a' }, { nope: 1 }], mode: '' })!
    expect(draft.attachments).toEqual([{ id: 'ok', name: 'n', path: 'p', size: 1 }])
    expect(draft.mentions).toEqual([{ path: 'a' }])
    expect(draft.mode).toBeNull()
    expect(cleanDraft({ text: '', attachments: [], mentions: [], mode: null })).toBeNull()
  })

  it('is consumed exactly once, verified after writing, and expires', () => {
    const store = new MemoryStore()
    const snap = buildDraftSnapshot({ fromSha: SHA_A, activeSessionId: null, fresh: { draft: { text: 'a', attachments: [], mentions: [], mode: null }, modelIdentity: null }, sessions: [] }, 10_000)
    expect(saveDraftSnapshot(store, snap)).toBe(true)
    expect(takeDraftSnapshot(store, 11_000)?.fresh.draft?.text).toBe('a')
    expect(store.map.has(DRAFT_SNAPSHOT_KEY)).toBe(false)
    expect(takeDraftSnapshot(store, 11_000)).toBeNull()
    saveDraftSnapshot(store, snap)
    expect(takeDraftSnapshot(store, 10_000 + 16 * 60_000)).toBeNull()
    expect(parseDraftSnapshot('{"version":2}', 0)).toBeNull()
    expect(parseDraftSnapshot('garbage', 0)).toBeNull()
    store.failWrites = true
    expect(saveDraftSnapshot(store, snap)).toBe(false)
  })
})

describe('deciding to reload', () => {
  function controller(browserSha: string | null = SHA_A, store: MemoryStore | null = new MemoryStore(), clock = { t: 100_000 }) {
    return { c: new ReloadController({ browserSha, store, now: () => clock.t }), store, clock }
  }
  const NEW = { ok: true, build: { sha: SHA_B, releaseId: 'r2' } }

  it('does nothing for a development page, a development server, or a bad answer', () => {
    const dev = controller(null)
    dev.c.observe(NEW)
    expect(dev.c.pending()).toBeNull()
    expect(dev.c.plan([], 60_000)).toEqual({ action: 'none' })

    const { c } = controller()
    c.observe({ ok: true, build: { sha: SHA_B, releaseId: null } })
    expect(c.plan([], 60_000)).toEqual({ action: 'none' })
    c.observe({ ok: true, build: null })
    expect(c.plan([], 60_000)).toEqual({ action: 'none' })
    c.observe({ ok: false, build: { sha: SHA_B, releaseId: 'r2' } })
    expect(c.plan([], 60_000)).toEqual({ action: 'none' })
    c.observe(null)
    expect(c.plan([], 60_000)).toEqual({ action: 'none' })
    c.observe({ ok: true, build: { sha: SHA_A, releaseId: 'r1' } })
    expect(c.plan([], 60_000)).toEqual({ action: 'none' })
  })

  it('reloads once per release when idle and unguarded, then only shows the banner', () => {
    const { c, store } = controller()
    c.observe(NEW)
    expect(c.pending()).toEqual({ sha: SHA_B, releaseId: 'r2' })
    expect(c.plan([], IDLE_BEFORE_RELOAD_MS - 1)).toMatchObject({ action: 'banner', requested: false, exhausted: false })
    const plan = c.plan([], IDLE_BEFORE_RELOAD_MS)
    expect(plan).toEqual({ action: 'reload', pending: { sha: SHA_B, releaseId: 'r2' }, explicit: false })
    expect(c.markReloading({ sha: SHA_B, releaseId: 'r2' }, false)).toBe(true)
    expect(store!.getItem(RELOADED_RELEASE_KEY)).toBe('r2')
    // The reloaded page still disagrees (cache, broken deploy): no loop.
    const again = controller(SHA_A, store)
    again.c.observe(NEW)
    expect(again.c.plan([], 60_000)).toMatchObject({ action: 'banner', exhausted: true })
    // A further release is a new decision.
    again.c.observe({ ok: true, build: { sha: 'c'.repeat(40), releaseId: 'r3' } })
    expect(again.c.plan([], 60_000)).toMatchObject({ action: 'reload', explicit: false })
  })

  it('never reloads automatically past a guard or on a stale observation', () => {
    const { c, clock } = controller()
    c.observe(NEW)
    expect(c.plan(['upload'], 60_000)).toMatchObject({ action: 'banner', blockers: ['upload'] })
    expect(c.plan(['editor', 'ime'], 60_000)).toMatchObject({ action: 'banner', blockers: ['editor', 'ime'] })
    clock.t += OBSERVATION_FRESH_MS + 1
    expect(c.plan([], 60_000)).toMatchObject({ action: 'banner' })
    c.observe(NEW)
    c.observe(null)
    // The server stopped answering: the banner stays, the reload waits.
    expect(c.plan([], 60_000)).toMatchObject({ action: 'banner' })
  })

  it('classifies guards: unsaved work, operations in flight, soft states', () => {
    for (const hard of ['ime', 'focused-input', 'dirty-input', 'editor', 'question-form', 'unsaved:editor', 'guard-error', 'something-new']) expect(guardClass(hard)).toBe('hard')
    for (const op of ['upload', 'command', 'session-create', 'save', 'snapshot', 'poise-change', 'saving:editor']) expect(guardClass(op)).toBe('operation')
    for (const soft of ['settings-open', 'typography-open', 'chat-pane-open', 'dialog-open', 'pending-request']) expect(guardClass(soft)).toBe('soft')
  })

  it('an explicit Refresh goes without the idle wait through soft guards, defers for unsaved work and operations, and keeps working after the auto reload is spent', () => {
    const { c, store } = controller()
    c.observe(NEW)
    c.requestRefresh()
    expect(c.plan(['settings-open', 'pending-request', 'dialog-open'], 0)).toEqual({ action: 'reload', pending: { sha: SHA_B, releaseId: 'r2' }, explicit: true })
    // Unsaved work is never discarded by a click; the click waits for it.
    expect(c.plan(['focused-input', 'settings-open'], 0)).toMatchObject({ action: 'banner', requested: true, blockers: ['focused-input'] })
    expect(c.plan(['editor'], 0)).toMatchObject({ action: 'banner', requested: true, blockers: ['editor'] })
    expect(c.plan(['unsaved:settings'], 0)).toMatchObject({ action: 'banner', requested: true })
    expect(c.plan(['ime'], 0)).toMatchObject({ action: 'banner', requested: true })
    expect(c.plan(['question-form'], 0)).toMatchObject({ action: 'banner', requested: true })
    expect(c.plan(['upload', 'typography-open'], 0)).toMatchObject({ action: 'banner', requested: true, blockers: ['upload'] })
    expect(c.plan(['command'], 0)).toMatchObject({ action: 'banner', requested: true })
    expect(c.plan(['snapshot'], 0)).toMatchObject({ action: 'banner', requested: true })
    // Still requested: once the field is saved the click completes on its own.
    expect(c.refreshRequested()).toBe(true)
    expect(c.plan([], 0)).toMatchObject({ action: 'reload', explicit: true })
    store!.setItem(RELOADED_RELEASE_KEY, 'r2')
    expect(c.plan([], 0)).toMatchObject({ action: 'reload', explicit: true })
    expect(c.markReloading({ sha: SHA_B, releaseId: 'r2' }, true)).toBe(true)
    // Without a pending build there is nothing to request.
    const idle = controller()
    idle.c.observe({ ok: true, build: { sha: SHA_A, releaseId: 'r1' } })
    idle.c.requestRefresh()
    expect(idle.c.refreshRequested()).toBe(false)
  })

  it('backs off the health poll, bounded, and recovers', () => {
    const { c } = controller()
    expect(c.nextHealthDelay()).toBe(HEALTH_POLL_MS)
    for (let i = 0; i < 10; i++) c.observe(null)
    expect(c.nextHealthDelay()).toBe(HEALTH_POLL_MAX_MS)
    c.observe({ ok: true, build: null })
    expect(c.nextHealthDelay()).toBe(HEALTH_POLL_MS)
  })

  it('never reloads automatically without a place to record it, and refuses one it cannot record', () => {
    const store = new MemoryStore()
    const { c } = controller(SHA_A, store)
    c.observe(NEW)
    store.failWrites = true
    // Storage went away: the plan already says banner, not reload.
    expect(c.plan([], 60_000)).toMatchObject({ action: 'banner', exhausted: true })
    expect(c.markReloading({ sha: SHA_B, releaseId: 'r2' }, false)).toBe(false)
    expect(c.markReloading({ sha: SHA_B, releaseId: 'r2' }, true)).toBe(true)
    // No storage at all: the person can still refresh, the tab never loops.
    const none = controller(SHA_A, null)
    none.c.observe(NEW)
    expect(none.c.plan([], 60_000)).toMatchObject({ action: 'banner', exhausted: true })
    expect(none.c.markReloading({ sha: SHA_B, releaseId: 'r2' }, false)).toBe(false)
    none.c.requestRefresh()
    expect(none.c.plan([], 0)).toMatchObject({ action: 'reload', explicit: true })
    expect(none.c.markReloading({ sha: SHA_B, releaseId: 'r2' }, true)).toBe(true)
  })
})
