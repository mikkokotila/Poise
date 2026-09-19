// The deploy card: one card for the session's latest Poise self-change, pinned
// after the transcript and outside the activity toggle. It is drawn from the
// supervisor's status alone, never from what the agent says; the agent may be
// gone entirely and the card keeps following the PR, the deploy and the health
// verification. Its one action is Revert, bound to the exact release the card
// is showing — no confirmation dialog, the server refuses a stale release.

import type { SelfChange, SelfUpdateStatus } from '../self-update-types'
import { escapeHtml } from '../markdown'
import { revertTarget, shortSha, stateLabel, tabRunsChange } from '../self-update-state'

/** A change the browser has asked for but the server has not yet described. */
export interface LocalPendingChange { id: string, request: string, sessionId: string, startedAt: number }

export interface DeployCardContext {
  status: SelfUpdateStatus | null
  change: SelfChange | null
  /** A `/poise` request in flight for the session on screen. */
  local: LocalPendingChange | null
  browserSha: string | null
  /** Rollback request for this change is on the wire. */
  reverting: boolean
  /** Last rollback attempt's outcome to show, if any. */
  revertNote: { text: string, level: 'info' | 'error' } | null
  /** The status endpoint could not be read; shown once a card exists. */
  statusError: string | null
}

export interface DeployCardHandlers {
  onRevert(changeId: string, expectedReleaseId: string): void
}

export interface DeployCard {
  el: HTMLElement
  render(ctx: DeployCardContext): void
  clear(): void
}

const MOVING = new Set(['implementing', 'checking', 'awaiting_ci', 'merging', 'merged', 'deploying', 'verifying', 'reverting'])

function safeHttpUrl(url: string | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url, 'http://127.0.0.1')
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null
  } catch { return null }
}

function link(url: string | undefined, text: string): string {
  const href = safeHttpUrl(url)
  return href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>` : escapeHtml(text)
}

export function deployCardHtml(ctx: DeployCardContext): string {
  const { status, change, local } = ctx
  if (!change && !local) return ''
  const request = change?.request || local?.request || ''
  const state = change ? change.state : 'implementing'
  const label = change ? stateLabel(change.state) : 'Starting'
  const moving = !change || MOVING.has(change.state)
  const level = state === 'failed' || state === 'blocked' ? 'error' : state === 'live' ? 'ok' : moving ? 'busy' : 'idle'
  const rows: string[] = []
  if (change?.prUrl || change?.prNumber) {
    const pr = change.prNumber ? `PR #${change.prNumber}` : 'Pull request'
    const title = change.title && change.title !== change.request ? ` · ${escapeHtml(change.title)}` : ''
    rows.push(`<div class="chat-deploy-row"><span class="chat-deploy-k">PR</span><span>${link(change.prUrl, pr)}${title}</span></div>`)
  }
  const shas: string[] = []
  if (change?.headSha) shas.push(`head <code>${escapeHtml(shortSha(change.headSha))}</code>`)
  if (change?.mergeSha) shas.push(`merge <code>${escapeHtml(shortSha(change.mergeSha))}</code>`)
  if (change?.baseSha) shas.push(`base <code>${escapeHtml(shortSha(change.baseSha))}</code>`)
  if (shas.length) rows.push(`<div class="chat-deploy-row"><span class="chat-deploy-k">Commits</span><span>${shas.join(' · ')}</span></div>`)
  if (change?.releaseId) {
    const runs = status ? tabRunsChange(change, status, ctx.browserSha) : null
    const tab = runs === null ? '' : runs ? ' · running in this tab' : ` · this tab runs <code>${escapeHtml(shortSha(ctx.browserSha) || 'unknown')}</code>`
    rows.push(`<div class="chat-deploy-row"><span class="chat-deploy-k">Release</span><span><code>${escapeHtml(change.releaseId)}</code>${tab}</span></div>`)
  }
  if (change?.sourceRevert) {
    const sr = change.sourceRevert
    const text = sr.state === 'merged' ? 'source reverted on main' : sr.state === 'conflict' ? 'source revert needs a hand (conflict)' : sr.state === 'failed' ? `source revert failed${sr.error ? ` — ${sr.error}` : ''}` : `source revert ${sr.state.replace('_', ' ')}`
    rows.push(`<div class="chat-deploy-row"><span class="chat-deploy-k">Source</span><span>${sr.prUrl ? link(sr.prUrl, text) : escapeHtml(text)}</span></div>`)
  }
  if (change?.error) rows.push(`<div class="chat-deploy-row chat-deploy-error"><span class="chat-deploy-k">Reason</span><span>${escapeHtml(change.error)}</span></div>`)
  if (status?.hold && change && status.hold.changeId === change.id) {
    rows.push(`<div class="chat-deploy-row chat-deploy-error"><span class="chat-deploy-k">Hold</span><span>Automatic updates are paused: ${escapeHtml(status.hold.reason || 'promotion hold')}</span></div>`)
  }
  if (ctx.statusError) rows.push(`<div class="chat-deploy-row chat-deploy-error"><span class="chat-deploy-k">Status</span><span>${escapeHtml(ctx.statusError)}</span></div>`)
  const target = change && status ? revertTarget(change, status) : null
  const actions: string[] = []
  if (target) {
    actions.push(`<button type="button" class="chat-card-btn chat-deploy-revert" data-change="${escapeHtml(target.changeId)}" data-release="${escapeHtml(target.expectedReleaseId)}" title="Restore the previous release (${escapeHtml(change?.previousReleaseId || 'retained locally')}); no confirmation"${ctx.reverting ? ' disabled' : ''}>${ctx.reverting ? 'Reverting…' : 'Revert'}</button>`)
  }
  const evidence = safeHttpUrl(status?.recoveryUrl)
  if (evidence) actions.push(`<a class="chat-deploy-evidence" href="${escapeHtml(evidence)}" target="_blank" rel="noopener noreferrer">View evidence</a>`)
  if (ctx.revertNote) actions.push(`<span class="st-help st-help-${ctx.revertNote.level}">${escapeHtml(ctx.revertNote.text)}</span>`)
  return `<div class="chat-card chat-deploy" data-state="${escapeHtml(state)}" data-level="${level}"${change ? ` data-change="${escapeHtml(change.id)}"` : ''}>`
    + `<div class="chat-deploy-head"><span class="chat-card-title">Poise change</span><span class="chat-deploy-state${moving ? ' moving' : ''}">${escapeHtml(label)}</span></div>`
    + `<div class="chat-deploy-request">${escapeHtml(request)}</div>`
    + (rows.length ? `<div class="chat-deploy-rows">${rows.join('')}</div>` : '')
    + (actions.length ? `<div class="chat-card-actions">${actions.join('')}</div>` : '')
    + `</div>`
}

export function createDeployCard(host: HTMLElement, handlers: DeployCardHandlers): DeployCard {
  const el = document.createElement('div')
  el.className = 'chat-deploy-host'
  el.hidden = true
  host.appendChild(el)
  let lastHtml = ''
  el.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.chat-deploy-revert')
    if (!btn || btn.disabled) return
    const changeId = btn.dataset.change
    const release = btn.dataset.release
    if (changeId && release) handlers.onRevert(changeId, release)
  })
  return {
    el,
    render(ctx) {
      const html = deployCardHtml(ctx)
      if (html === lastHtml) return
      lastHtml = html
      el.innerHTML = html
      el.hidden = !html
    },
    clear() {
      lastHtml = ''
      el.innerHTML = ''
      el.hidden = true
    },
  }
}
