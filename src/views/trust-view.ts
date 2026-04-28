// Trust dashboard view — reads from /api/cache/trust

import { getSettings } from '../config'

const RANGE_KEY = 'poise-trust-range'

function subtitle(): string {
  const org = getSettings().org
  return org ? `${org} · last ${rangeDays} days` : `last ${rangeDays} days`
}

interface TrustPayload {
  range_days: number
  kpis: {
    rework_pct: number
    rework_pct_prev: number
    silent_pct: number
    silent_pct_prev: number
    bounce_mean: number
    bounce_mean_prev: number
    blast_median_loc: number
    blast_median_loc_prev: number
  }
  tag_coverage_pct: number
  files_coverage_pct: number
  rework_weekly: Array<{ week: string; feat: number; fix: number; other: number }>
  engagement: Array<{ bucket: string; count: number; pct: number }>
  iteration_buckets: Array<{ bucket: string; count: number; pct: number }>
  hotspots: Array<{ filename: string; prs: number; loc: number; last: string }>
}

let rangeDays: number = loadRange()
let initialized = false

function loadRange(): number {
  try {
    const v = Number(localStorage.getItem(RANGE_KEY))
    if ([7, 30, 90, 365].includes(v)) return v
  } catch { /* ignore */ }
  return 90
}
function saveRange() { localStorage.setItem(RANGE_KEY, String(rangeDays)) }

function escapeHtml(s: string): string { const d = document.createElement('div'); d.textContent = s; return d.innerHTML }

function fmtPct(n: number): string { return `${n.toFixed(1)}%` }
function fmtNum(n: number, digits = 1): string { return n.toFixed(digits) }
function fmtLoc(n: number): string { return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)) }

function delta(current: number, prev: number, goodDirection: 'up' | 'down', unit: 'pct' | 'pt' | 'num' = 'pct'): { text: string; cls: string } {
  if (prev === 0 && current === 0) return { text: '—', cls: 'flat' }
  let change: number
  let display: string
  if (unit === 'pt') {
    change = current - prev
    if (Math.abs(change) < 0.5) return { text: '—', cls: 'flat' }
    display = `${change > 0 ? '↑' : '↓'} ${Math.abs(change).toFixed(1)}pt`
  } else if (unit === 'num') {
    change = current - prev
    if (prev !== 0 && Math.abs((change / prev) * 100) < 3) return { text: '—', cls: 'flat' }
    if (Math.abs(change) < 0.05) return { text: '—', cls: 'flat' }
    display = `${change > 0 ? '↑' : '↓'} ${Math.abs(change).toFixed(2)}`
  } else {
    if (prev === 0) return { text: '—', cls: 'flat' }
    change = ((current - prev) / prev) * 100
    if (Math.abs(change) < 3) return { text: '—', cls: 'flat' }
    display = `${change > 0 ? '↑' : '↓'} ${Math.abs(change).toFixed(0)}%`
  }
  const dir = current > prev ? 'up' : 'down'
  const good = dir === goodDirection
  return { text: display, cls: good ? 'good' : 'bad' }
}

function kpiTile(label: string, value: string, d: { text: string; cls: string }): string {
  return `
    <div class="kpi">
      <div class="kpi-label">${label}</div>
      <div class="kpi-value">${value}</div>
      <div class="kpi-delta ${d.cls}">${d.text}</div>
    </div>
  `
}

function renderReworkTrend(data: TrustPayload['rework_weekly']): string {
  if (data.length === 0) return '<div class="section-empty">No merged PRs in range.</div>'
  const maxY = Math.max(...data.map((d) => d.feat + d.fix + d.other), 1)
  const w = 1000
  const h = 120
  const pad = 8
  const barGap = 3
  const barWidth = ((w - pad * 2) / data.length) - barGap

  const bars = data.map((d, i) => {
    const x = pad + i * (barWidth + barGap)
    const hTotal = ((d.feat + d.fix + d.other) / maxY) * (h - pad * 2)
    const hFeat = (d.feat / maxY) * (h - pad * 2)
    const hFix = (d.fix / maxY) * (h - pad * 2)
    const hOther = (d.other / maxY) * (h - pad * 2)
    const yBottom = h - pad
    return `
      <rect x="${x}" y="${yBottom - hOther}" width="${barWidth}" height="${hOther}" class="rw-other"/>
      <rect x="${x}" y="${yBottom - hOther - hFeat}" width="${barWidth}" height="${hFeat}" class="rw-feat"/>
      <rect x="${x}" y="${yBottom - hOther - hFeat - hFix}" width="${barWidth}" height="${hFix}" class="rw-fix"/>
      <title>${d.week}: ${d.feat} feat, ${d.fix} fix, ${d.other} other (${hTotal.toFixed(0)}px)</title>
    `
  }).join('')

  return `
    <svg viewBox="0 0 ${w} ${h}" class="rework-chart" preserveAspectRatio="none">
      ${bars}
    </svg>
    <div class="rework-legend">
      <span><span class="sw feat"></span> feat</span>
      <span><span class="sw fix"></span> fix / revert</span>
      <span><span class="sw other"></span> other</span>
    </div>
  `
}

function renderBuckets(title: string, data: Array<{ bucket: string; count: number; pct: number }>, highlightFirst: boolean): string {
  if (data.reduce((s, d) => s + d.count, 0) === 0) return '<div class="section-empty">No merged PRs in range.</div>'
  const max = Math.max(...data.map((d) => d.count), 1)
  const rows = data.map((d, i) => {
    const w = (d.count / max) * 100
    const cls = highlightFirst && i === 0 ? 'bar-warn' : ''
    return `
      <div class="bucket-row">
        <div class="bucket-label">${escapeHtml(d.bucket)}</div>
        <div class="bucket-bar"><div class="bucket-fill ${cls}" style="width:${w}%"></div></div>
        <div class="bucket-count">${d.count}</div>
        <div class="bucket-pct">${d.pct.toFixed(0)}%</div>
      </div>
    `
  }).join('')
  return `
    <div class="buckets-title">${title}</div>
    <div class="buckets">${rows}</div>
  `
}

function relativeDate(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const days = Math.floor(diff / 86400000)
  if (days === 0) return 'today'
  if (days === 1) return '1d'
  if (days < 30) return `${days}d`
  const months = Math.floor(days / 30)
  return `${months}mo`
}

function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s
  const keep = Math.floor((max - 1) / 2)
  return s.slice(0, keep) + '\u2026' + s.slice(-keep)
}

function renderHotspots(data: TrustPayload['hotspots']): string {
  if (data.length === 0) return '<div class="section-empty">No file churn data. <button class="link-btn" id="trust-backfill">Backfill files</button></div>'
  const maxPrs = Math.max(...data.map((h) => h.prs), 1)
  const rows = data.map((h) => {
    const barW = (h.prs / maxPrs) * 100
    return `
      <tr>
        <td class="hs-name" title="${escapeHtml(h.filename)}">${escapeHtml(truncateMiddle(h.filename, 60))}</td>
        <td class="hs-bar"><div class="hs-fill" style="width:${barW}%"></div></td>
        <td class="hs-num">${h.prs}</td>
        <td class="hs-num">${fmtLoc(h.loc)}</td>
        <td class="hs-num">${relativeDate(h.last)}</td>
      </tr>
    `
  }).join('')
  return `
    <table class="hs-table">
      <colgroup>
        <col class="c-name">
        <col class="c-bar">
        <col class="c-prs">
        <col class="c-loc">
        <col class="c-last">
      </colgroup>
      <thead>
        <tr>
          <th>File</th>
          <th></th>
          <th class="hs-num">PRs</th>
          <th class="hs-num">±LOC</th>
          <th class="hs-num">Last</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `
}

function renderShell(): string {
  return `
    <header class="view-header" id="trust-header">
      <div class="view-title">Trust <span class="view-sub">${subtitle()}</span></div>
      <div class="range-picker">
        ${[7, 30, 90, 365].map((d) => `<button data-range="${d}" class="${d === rangeDays ? 'active' : ''}">${d === 365 ? '1y' : d + 'd'}</button>`).join('')}
      </div>
    </header>
    <div id="trust-kpis" class="kpi-row"></div>
    <div class="flow-section">
      <div class="section-label-row">
        <div class="section-label">Rework trend <span class="section-note" id="trust-rework-note"></span></div>
      </div>
      <div id="trust-rework"></div>
    </div>
    <div class="flow-two-col">
      <div class="flow-section">
        <div class="section-label">Review engagement</div>
        <div id="trust-engagement"></div>
      </div>
      <div class="flow-section">
        <div class="section-label">Return-to-author</div>
        <div id="trust-iterations"></div>
      </div>
    </div>
    <div class="flow-section">
      <div class="section-label-row">
        <div class="section-label">Hotspots</div>
        <div class="section-note" id="trust-hotspot-note"></div>
      </div>
      <div id="trust-hotspots"></div>
    </div>
  `
}

async function loadAndRender() {
  const view = document.getElementById('view-trust')!
  try {
    const res = await fetch(`/api/cache/trust?range=${rangeDays}`)
    if (!res.ok) throw new Error(`Cache ${res.status}`)
    const data: TrustPayload = await res.json()

    const k = data.kpis
    const kpisHtml =
      kpiTile('Rework', fmtPct(k.rework_pct), delta(k.rework_pct, k.rework_pct_prev, 'down', 'pt')) +
      kpiTile('Silent merges', fmtPct(k.silent_pct), delta(k.silent_pct, k.silent_pct_prev, 'down', 'pt')) +
      kpiTile('Bounce', fmtNum(k.bounce_mean, 2), delta(k.bounce_mean, k.bounce_mean_prev, 'down', 'num')) +
      kpiTile('Blast', `${fmtLoc(k.blast_median_loc)} loc`, delta(k.blast_median_loc, k.blast_median_loc_prev, 'down', 'pct'))

    view.querySelector('#trust-kpis')!.innerHTML = kpisHtml
    view.querySelector('#trust-rework')!.innerHTML = renderReworkTrend(data.rework_weekly)
    view.querySelector('#trust-engagement')!.innerHTML = renderBuckets('Non-author comments per merged PR', data.engagement, true)
    view.querySelector('#trust-iterations')!.innerHTML = renderBuckets('"Changes requested" rounds', data.iteration_buckets, false)
    view.querySelector('#trust-hotspots')!.innerHTML = renderHotspots(data.hotspots)

    // Coverage notes
    const reworkNote = view.querySelector('#trust-rework-note')!
    reworkNote.textContent = data.tag_coverage_pct < 100
      ? `${data.tag_coverage_pct.toFixed(0)}% of merged PRs have conventional tags`
      : ''
    const hotspotNote = view.querySelector('#trust-hotspot-note')!
    hotspotNote.textContent = data.files_coverage_pct < 100
      ? `files data: ${data.files_coverage_pct.toFixed(0)}%`
      : ''

    // Wire backfill button if present
    const backfillBtn = view.querySelector('#trust-backfill') as HTMLButtonElement | null
    if (backfillBtn) {
      backfillBtn.addEventListener('click', async () => {
        backfillBtn.disabled = true
        backfillBtn.textContent = 'Backfilling…'
        try {
          const r = await fetch('/api/cache/backfill-files?limit=600', { method: 'POST' })
          const j = await r.json()
          console.log('[trust] backfill:', j)
          loadAndRender()
        } catch (err) {
          backfillBtn.textContent = 'Backfill failed'
          console.error(err)
        }
      })
    }
  } catch (err) {
    view.innerHTML = `<div class="flow-error">Error loading trust data: ${escapeHtml((err as Error).message)}</div>`
  }
}

export function initTrustView() {
  const view = document.getElementById('view-trust')!
  if (!initialized) {
    initialized = true
    view.innerHTML = renderShell()
    view.querySelector('#trust-header')!.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button')
      if (!btn || !btn.dataset.range) return
      const next = Number(btn.dataset.range)
      if (next === rangeDays) return
      rangeDays = next
      saveRange()
      view.querySelectorAll<HTMLButtonElement>('[data-range]').forEach((b) => {
        b.classList.toggle('active', Number(b.dataset.range) === rangeDays)
      })
      const sub = view.querySelector('.view-sub')
      if (sub) sub.textContent = subtitle()
      loadAndRender()
    })
  }
  loadAndRender()
}
