// The tab-wide watch that moves a browser onto a newly promoted Poise build.
// It polls `/api/health` for the served build's SHA, compares it with the SHA
// this bundle was compiled from, and — only when the app reports nothing in
// flight and nothing unsaved — writes the Chat drafts to tab-local storage and
// reloads. Anything less certain shows a banner with an explicit Refresh.
//
// The decision rules are in self-update-reload (pure, unit-tested) and the
// guards in self-update-guards. This file is the wiring: the timers, the
// banner and the reload itself. The Chat view provides the drafts.

import { BUILD_SHA } from './build-identity'
import { buildDraftSnapshot, saveDraftSnapshot, parseDraftSnapshot, DRAFT_SNAPSHOT_KEY, type DraftSnapshotInput } from './self-update-drafts'
import { collectBlockers, describeBlocker, installDomGuards } from './self-update-guards'
import { ReloadController, guardClass, type HealthObservation, type ReloadPlan } from './self-update-reload'
import { parseBuildIdentity, shortSha } from './self-update-state'

export { registerReloadGuard, declareUnsavedWork, collectBlockers } from './self-update-guards'

export type DraftProvider = () => DraftSnapshotInput

let draftProvider: DraftProvider | null = null

/** The Chat view hands over its drafts here; only one provider exists. */
export function registerDraftProvider(provider: DraftProvider): () => void {
  draftProvider = provider
  return () => { if (draftProvider === provider) draftProvider = null }
}

let lastActivity = 0

// ── Draft snapshot ───────────────────────────────────────────────────────

function emptyDraftInput(): DraftSnapshotInput {
  return { fromSha: BUILD_SHA, activeSessionId: null, fresh: { draft: null, modelIdentity: null }, sessions: [] }
}

/** Write every draft the app knows about; `false` means the reload must wait. */
export function snapshotDrafts(): boolean {
  let input: DraftSnapshotInput
  try {
    if (!draftProvider) {
      // Chat may not have mounted in this tab yet. Its saved drafts still
      // belong to it; an update from Current/Editor must not replace them with emptiness.
      const saved = parseDraftSnapshot(sessionStorage.getItem(DRAFT_SNAPSHOT_KEY))
      if (saved) return saveDraftSnapshot(sessionStorage, { ...saved, fromSha: BUILD_SHA, savedAt: Date.now() })
    }
    input = draftProvider ? draftProvider() : emptyDraftInput()
  } catch { return false }
  try { return saveDraftSnapshot(sessionStorage, buildDraftSnapshot({ ...input, fromSha: BUILD_SHA })) } catch { return false }
}

// ── Banner ───────────────────────────────────────────────────────────────

let bannerEl: HTMLElement | null = null
let lastBannerHtml = ''

function bannerHtml(plan: ReloadPlan): string {
  if (plan.action !== 'banner') return ''
  const named = plan.blockers.map(describeBlocker)
  const list = `${named.slice(0, 3).join(', ')}${named.length > 3 ? '…' : ''}`
  const lead = plan.exhausted
    ? `This tab did not pick up the new Poise build (${shortSha(plan.pending.sha)}).`
    : `A new Poise build is live (${shortSha(plan.pending.sha)}).`
  let hint: string
  if (plan.requested) {
    const unsaved = plan.blockers.some((b) => guardClass(b) === 'hard')
    hint = !named.length ? 'Refreshing…' : unsaved ? `Refresh is waiting for ${list} — save or clear it and the tab will refresh.` : `Refreshing after ${list}.`
  } else {
    hint = named.length ? `Waiting for ${list}. Refresh keeps your drafts.` : 'Refresh keeps your drafts.'
  }
  return `<span class="self-update-banner-text">${lead} ${hint}</span>`
    + `<button type="button" class="self-update-refresh"${plan.requested ? ' disabled' : ''}>${plan.requested ? 'Refreshing…' : 'Refresh'}</button>`
}

function renderBanner(plan: ReloadPlan, onRefresh: () => void): void {
  const html = bannerHtml(plan)
  if (!html) {
    if (bannerEl) { bannerEl.hidden = true; bannerEl.innerHTML = '' }
    lastBannerHtml = ''
    return
  }
  if (!bannerEl) {
    bannerEl = document.createElement('div')
    bannerEl.className = 'self-update-banner'
    bannerEl.setAttribute('role', 'status')
    bannerEl.setAttribute('aria-live', 'polite')
    bannerEl.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.self-update-refresh')) onRefresh()
    })
    document.body.appendChild(bannerEl)
  }
  if (html !== lastBannerHtml) { lastBannerHtml = html; bannerEl.innerHTML = html }
  bannerEl.hidden = false
}

// ── Watch ────────────────────────────────────────────────────────────────

export interface SelfUpdateWatch {
  stop(): void
  /** Re-read the guards and act; also used after an explicit Refresh click. */
  check(): void
  /** Ask the server now instead of at the next interval. */
  poll(): Promise<void>
}

const GUARD_CHECK_MS = 2_000
let installed: SelfUpdateWatch | null = null

export function installSelfUpdateWatch(opts: { browserSha?: string | null, fetchHealth?: () => Promise<HealthObservation | null> } = {}): SelfUpdateWatch {
  if (installed) return installed
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return installed = { stop() {}, check() {}, async poll() {} }
  }
  const browserSha = opts.browserSha === undefined ? BUILD_SHA : opts.browserSha
  let store: Storage | null = null
  try { store = window.sessionStorage } catch { store = null }
  const controller = new ReloadController({ browserSha, store })
  let healthTimer: ReturnType<typeof setTimeout> | null = null
  let guardTimer: ReturnType<typeof setTimeout> | null = null
  let reloading = false
  let stopped = false

  const fetchHealth = opts.fetchHealth || (async (): Promise<HealthObservation | null> => {
    try {
      const res = await fetch('/api/health', { cache: 'no-store' })
      let body: unknown = null
      try { body = await res.json() } catch { body = null }
      return { ok: res.ok, build: parseBuildIdentity(body) }
    } catch {
      return null
    }
  })

  const onActivity = () => { lastActivity = Date.now() }
  lastActivity = Date.now()
  installDomGuards()
  document.addEventListener('keydown', onActivity, true)
  document.addEventListener('pointerdown', onActivity, true)
  document.addEventListener('input', onActivity, true)

  /** Save drafts, record the release, go. Returns the banner to show instead when it cannot. */
  function reload(explicit: boolean, pending: { sha: string, releaseId: string }): ReloadPlan | null {
    if (reloading) return null
    if (!snapshotDrafts()) {
      return { action: 'banner', pending, blockers: ['snapshot'], requested: explicit, exhausted: controller.exhausted(pending) }
    }
    if (!controller.markReloading(pending, explicit)) {
      return { action: 'banner', pending, blockers: [], requested: false, exhausted: true }
    }
    reloading = true
    window.location.reload()
    return null
  }

  function check(): void {
    if (stopped || reloading) return
    const blockers = controller.pending() ? collectBlockers() : []
    let plan = controller.plan(blockers, Date.now() - lastActivity)
    if (plan.action === 'reload') {
      const fallback = reload(plan.explicit, plan.pending)
      if (!fallback) return
      plan = fallback
    }
    renderBanner(plan, onRefresh)
    if (guardTimer) clearTimeout(guardTimer)
    guardTimer = plan.action === 'banner' ? setTimeout(check, GUARD_CHECK_MS) : null
    // A click that waited long enough for the observation to go stale should
    // not also wait for the next interval: ask now.
    if (plan.action === 'banner' && plan.requested && !plan.blockers.length && !healthPending) void poll()
  }

  function onRefresh(): void {
    controller.requestRefresh()
    // A fresh observation first: the decision needs one, and a person who
    // clicked should not wait for the next interval.
    void poll()
  }

  let healthPending = false
  async function poll(): Promise<void> {
    if (stopped || healthPending) return
    if (healthTimer) { clearTimeout(healthTimer); healthTimer = null }
    // Nothing to compare against: development builds do not poll at all.
    if (!browserSha) return
    healthPending = true
    try { controller.observe(await fetchHealth()) } finally { healthPending = false }
    if (stopped) return
    check()
    healthTimer = setTimeout(() => { void poll() }, controller.nextHealthDelay())
  }

  const onVisibility = () => { if (document.visibilityState === 'visible') void poll() }
  document.addEventListener('visibilitychange', onVisibility)

  installed = {
    stop() {
      stopped = true
      if (healthTimer) clearTimeout(healthTimer)
      if (guardTimer) clearTimeout(guardTimer)
      document.removeEventListener('keydown', onActivity, true)
      document.removeEventListener('pointerdown', onActivity, true)
      document.removeEventListener('input', onActivity, true)
      document.removeEventListener('visibilitychange', onVisibility)
      renderBanner({ action: 'none' }, onRefresh)
      installed = null
    },
    check,
    poll,
  }
  void poll()
  return installed
}
