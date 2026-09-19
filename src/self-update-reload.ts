// Decides when a tab may reload itself onto a newly promoted build. Pure state
// over observations of `/api/health` and reports from the app's own guards,
// so every rule here has a unit test and the DOM wiring (self-update-watch)
// only carries observations in and actions out.
//
// Rules, in order of who wins:
//   - A page compiled without a SHA (development, a dirty build) never reloads
//     and never shows the banner: there is nothing to compare.
//   - A server without a release id is development or a hand-run build: no
//     reload. Offline, degraded and malformed answers never trigger anything.
//   - The comparison is compiled SHA against served build SHA only. Checkout
//     state is not a version.
//   - One automatic reload per release id, remembered in session storage: if
//     the reloaded page still disagrees with the server, it shows the banner
//     and waits for a person rather than looping.
//   - An automatic reload needs every guard clear, the person idle, and the
//     draft snapshot written. The banner with Refresh is always the fallback.
//   - An explicit Refresh is a decision: it preserves drafts, ignores soft
//     guards (a clean open panel, a permission card that history restores),
//     and defers — never discards — unsaved work and operations in flight.
//   - Without a place to record "reloaded for this release" there is no
//     automatic reload at all; only the person can go, and a loop is impossible.

import type { BuildIdentity } from './self-update-types'

export interface HealthObservation { ok: boolean, build: BuildIdentity | null }

export interface PendingBuild { sha: string, releaseId: string }

export type ReloadPlan =
  | { action: 'none' }
  | { action: 'banner', pending: PendingBuild, blockers: string[], requested: boolean, exhausted: boolean }
  | { action: 'reload', pending: PendingBuild, explicit: boolean }

export interface ReloadStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const HEALTH_POLL_MS = 30_000
export const HEALTH_POLL_MAX_MS = 5 * 60_000
/** No keyboard or pointer activity for this long before an automatic reload. */
export const IDLE_BEFORE_RELOAD_MS = 10_000
/** A good observation older than this is not evidence for reloading. */
export const OBSERVATION_FRESH_MS = 3 * HEALTH_POLL_MS
export const RELOADED_RELEASE_KEY = 'poise-self-update-reloaded-release'

/** Something in flight that finishes on its own; an explicit Refresh waits for it. */
export const OPERATION_GUARDS: ReadonlySet<string> = new Set(['upload', 'command', 'session-create', 'save', 'snapshot', 'poise-change'])
/** Nothing would be lost, but not a moment to pull the page away on its own:
 *  an explicit Refresh goes through these. */
export const SOFT_GUARDS: ReadonlySet<string> = new Set(['settings-open', 'typography-open', 'chat-pane-open', 'dialog-open', 'pending-request'])

export type GuardClass = 'hard' | 'operation' | 'soft'

/** Anything not listed above is unsaved work: `ime`, `focused-input`,
 *  `dirty-input`, `editor`, `question-form`, `unsaved:<source>`, `guard-error`. */
export function guardClass(name: string): GuardClass {
  if (OPERATION_GUARDS.has(name) || name.startsWith('saving:')) return 'operation'
  if (SOFT_GUARDS.has(name)) return 'soft'
  return 'hard'
}

export class ReloadController {
  private readonly browserSha: string | null
  private readonly store: ReloadStore | null
  private readonly now: () => number
  private lastGood: { build: BuildIdentity, at: number } | null = null
  private lastOk = false
  private failures = 0
  /** Release an explicit Refresh was asked for; a different release supersedes it. */
  private requestedFor: string | null = null

  constructor(opts: { browserSha: string | null, store?: ReloadStore | null, now?: () => number }) {
    this.browserSha = opts.browserSha && /^[0-9a-f]{40}$/.test(opts.browserSha) ? opts.browserSha : null
    this.store = opts.store ?? null
    this.now = opts.now ?? (() => Date.now())
  }

  /** Record a `/api/health` answer; `null` means the request itself failed. */
  observe(obs: HealthObservation | null): void {
    if (!obs || !obs.ok) {
      this.lastOk = false
      this.failures += 1
      return
    }
    this.lastOk = true
    this.failures = 0
    if (obs.build && obs.build.sha && /^[0-9a-f]{40}$/.test(obs.build.sha)) {
      this.lastGood = { build: obs.build, at: this.now() }
    } else {
      // A healthy server without a build identity is development: forget
      // any earlier pending release rather than keep a stale banner.
      this.lastGood = null
    }
  }

  /** Time until the next health request, with bounded backoff on failure. */
  nextHealthDelay(): number {
    if (!this.failures) return HEALTH_POLL_MS
    return Math.min(HEALTH_POLL_MS * 2 ** Math.min(this.failures, 6), HEALTH_POLL_MAX_MS)
  }

  /** The release this tab is behind, if any. */
  pending(): PendingBuild | null {
    if (!this.browserSha || !this.lastGood) return null
    const { sha, releaseId } = this.lastGood.build
    if (!sha || !releaseId || sha === this.browserSha) return null
    return { sha, releaseId }
  }

  requestRefresh(): void {
    const pending = this.pending()
    if (pending) this.requestedFor = pending.releaseId
  }

  refreshRequested(): boolean {
    const pending = this.pending()
    return !!pending && this.requestedFor === pending.releaseId
  }

  private reloadedFor(): string | null {
    try { return this.store?.getItem(RELOADED_RELEASE_KEY) ?? null } catch { return null }
  }

  /** Whether an automatic reload already happened for this release in this
   *  tab — or could never be recorded, which counts the same. */
  exhausted(pending: PendingBuild): boolean {
    if (!this.canRecord()) return true
    return this.reloadedFor() === pending.releaseId
  }

  /** A loop record needs somewhere to live. */
  private canRecord(): boolean {
    if (!this.store) return false
    try {
      const probe = `${RELOADED_RELEASE_KEY}:probe`
      this.store.setItem(probe, '1')
      return this.store.getItem(probe) === '1'
    } catch { return false }
  }

  /** What to do now, given the guards' blockers and how long the person has been idle. */
  plan(blockers: readonly string[], idleForMs: number): ReloadPlan {
    const pending = this.pending()
    if (!pending) {
      this.requestedFor = null
      return { action: 'none' }
    }
    const fresh = this.lastOk && !!this.lastGood && this.now() - this.lastGood.at <= OBSERVATION_FRESH_MS
    const exhausted = this.exhausted(pending)
    if (this.requestedFor === pending.releaseId) {
      // Unsaved work and operations in flight defer the click; soft guards do not.
      const deferring = blockers.filter((b) => guardClass(b) !== 'soft')
      if (!deferring.length && fresh) return { action: 'reload', pending, explicit: true }
      return { action: 'banner', pending, blockers: deferring, requested: true, exhausted }
    }
    if (!exhausted && fresh && !blockers.length && idleForMs >= IDLE_BEFORE_RELOAD_MS) {
      return { action: 'reload', pending, explicit: false }
    }
    return { action: 'banner', pending, blockers: [...blockers], requested: false, exhausted }
  }

  /** Remember the reload about to happen. Returns `false` when the record could
   *  not be written and the reload was automatic: without the record a broken
   *  deploy could reload forever, so the caller must fall back to the banner.
   *  An explicit reload is the person's, and goes either way. */
  markReloading(pending: PendingBuild, explicit: boolean): boolean {
    try {
      this.store?.setItem(RELOADED_RELEASE_KEY, pending.releaseId)
      return explicit || (!!this.store && this.store.getItem(RELOADED_RELEASE_KEY) === pending.releaseId)
    } catch {
      return explicit
    }
  }
}
