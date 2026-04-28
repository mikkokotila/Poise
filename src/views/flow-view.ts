// Flow dashboard view — reads from /api/cache/flow

import { getSettings } from '../config'

const RANGE_KEY = 'poise-flow-range'

function subtitle(): string {
  const org = getSettings().org
  return org ? `${org} · last ${rangeDays} days` : `last ${rangeDays} days`
}

interface Kpis {
  cycle_time_days_median: number | null
  cycle_time_days_prev: number | null
  throughput_per_month: number
  throughput_per_month_prev: number
  first_review_hours_median: number | null
  first_review_hours_prev: number | null
  waste_pct: number
  waste_pct_prev: number
}

interface FlowPayload {
  range_days: number
  total_prs: number
  kpis: Kpis
  flow_weekly: Array<{ week: string; opened: number; merged: number }>
  work_mix: Array<{ tag: string; count: number }>
  people: Array<{ author: string; prs: number; reviews: number; comments: number; merge_rate: number }>
  waste_monthly: Array<{ month: string; stale: number; wasted_reviews: number; abandoned: number }>
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

function escapeHtml(s: string): string {
  const d = document.createElement('div'); d.textContent = s; return d.innerHTML
}

// Format number: 2.3d, 4h, 47/mo, 8%
function fmtDays(d: number | null): string {
  if (d == null) return '—'
  if (d < 1) return `${(d * 24).toFixed(1)}h`
  return `${d.toFixed(1)}d`
}
function fmtHours(h: number | null): string {
  if (h == null) return '—'
  if (h < 1) return `${(h * 60).toFixed(0)}m`
  if (h < 24) return `${h.toFixed(1)}h`
  return `${(h / 24).toFixed(1)}d`
}
function fmtNum(n: number): string { return n.toFixed(0) }
function fmtPct(n: number): string { return `${n.toFixed(1)}%` }

// Delta calc: returns { text, dir } where dir is 'up'/'down'/'flat'
// goodDirection = 'down' if lower-is-better (cycle time), 'up' if higher-is-better (throughput)
function delta(current: number | null, prev: number | null, goodDirection: 'up' | 'down'): { text: string; cls: string } {
  if (current == null || prev == null || prev === 0) return { text: '—', cls: 'flat' }
  const pct = ((current - prev) / prev) * 100
  if (Math.abs(pct) < 3) return { text: '—', cls: 'flat' }
  const dir = pct > 0 ? 'up' : 'down'
  const good = dir === goodDirection
  const arrow = pct > 0 ? '↑' : '↓'
  return { text: `${arrow} ${Math.abs(pct).toFixed(0)}%`, cls: good ? 'good' : 'bad' }
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

function renderFlowStrip(data: FlowPayload['flow_weekly']): string {
  if (data.length === 0) return '<div class="section-empty">No activity.</div>'
  const maxY = Math.max(...data.map((d) => Math.max(d.opened, d.merged)), 1)
  const w = 1000
  const h = 120
  const pad = 8
  const step = (w - pad * 2) / Math.max(1, data.length - 1)

  const pathOpened = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${pad + i * step} ${h - pad - (d.opened / maxY) * (h - pad * 2)}`).join(' ')
  const pathMerged = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${pad + i * step} ${h - pad - (d.merged / maxY) * (h - pad * 2)}`).join(' ')
  const pathOpenedArea = `${pathOpened} L ${pad + (data.length - 1) * step} ${h - pad} L ${pad} ${h - pad} Z`

  return `
    <svg viewBox="0 0 ${w} ${h}" class="flow-chart" preserveAspectRatio="none">
      <path d="${pathOpenedArea}" class="flow-area-opened"/>
      <path d="${pathOpened}" class="flow-line-opened"/>
      <path d="${pathMerged}" class="flow-line-merged"/>
    </svg>
    <div class="flow-legend">
      <span><span class="sw opened"></span> opened</span>
      <span><span class="sw merged"></span> merged</span>
    </div>
  `
}

function renderWorkMix(data: FlowPayload['work_mix']): string {
  if (data.length === 0) return '<div class="section-empty">No PR data.</div>'
  const total = data.reduce((s, d) => s + d.count, 0)
  // Guarantee a minimum visible slice (1.5%) by squeezing the rest proportionally
  const MIN = 1.5
  const raw = data.map((d) => ({ tag: d.tag, count: d.count, pct: (d.count / total) * 100 }))
  const overshoot = raw.filter((r) => r.pct < MIN).reduce((s, r) => s + (MIN - r.pct), 0)
  const excess = raw.filter((r) => r.pct >= MIN).reduce((s, r) => s + r.pct, 0)
  const display = raw.map((r) => ({
    ...r,
    displayPct: r.pct < MIN ? MIN : r.pct * (1 - overshoot / Math.max(excess, 1)),
  }))
  const segments = display.map((d) => (
    `<div class="mix-segment tag-${d.tag}" style="width:${d.displayPct}%" title="${escapeHtml(d.tag)}: ${d.count} (${d.pct.toFixed(0)}%)"></div>`
  )).join('')
  const legend = raw.slice(0, 6).map((d) => (
    `<span class="mix-label tag-${d.tag}"><span class="sw"></span>${escapeHtml(d.tag)} <span class="mix-pct">${d.pct.toFixed(0)}%</span></span>`
  )).join('')
  return `<div class="mix-bar">${segments}</div><div class="mix-legend">${legend}</div>`
}

function renderPeople(data: FlowPayload['people']): string {
  if (data.length === 0) return '<div class="section-empty">No contributors in range.</div>'
  const rows = data.map((p) => {
    const mr = p.merge_rate
    const mrCls = mr >= 90 ? 'mr-high' : mr >= 60 ? 'mr-mid' : 'mr-low'
    return `
    <tr>
      <td class="ppl-name">${escapeHtml(p.author)}</td>
      <td class="ppl-num">${p.prs}</td>
      <td class="ppl-num">${p.reviews}</td>
      <td class="ppl-num">${p.comments}</td>
      <td class="ppl-num ${mrCls}">${mr.toFixed(0)}%</td>
    </tr>
  `}).join('')
  return `
    <table class="ppl-table">
      <thead>
        <tr>
          <th>Author</th>
          <th class="ppl-num">PRs</th>
          <th class="ppl-num">Reviews</th>
          <th class="ppl-num">Comments</th>
          <th class="ppl-num">Merge</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `
}

function renderWaste(data: FlowPayload['waste_monthly']): string {
  if (data.length === 0) return '<div class="section-empty">No waste data.</div>'
  const render = (rows: FlowPayload['waste_monthly'], key: 'stale' | 'wasted_reviews' | 'abandoned', label: string) => {
    const max = Math.max(...rows.map((r) => r[key]), 1)
    const median = rows.map((r) => r[key]).sort((a, b) => a - b)[Math.floor(rows.length / 2)] || 0
    const bars = rows.map((r) => {
      const v = r[key]
      const high = v > median && median > 0
      return `<div class="waste-bar ${high ? 'high' : ''}" style="height:${(v / max) * 100}%" title="${r.month}: ${v}"></div>`
    }).join('')
    return `<div class="waste-block"><div class="waste-label">${label}</div><div class="waste-bars">${bars}</div></div>`
  }
  return `
    ${render(data, 'stale', 'Stale PRs')}
    ${render(data, 'wasted_reviews', 'Wasted')}
    ${render(data, 'abandoned', 'Abandoned')}
  `
}

function renderShell(): string {
  return `
    <header class="view-header" id="flow-header">
      <div class="view-title">Flow <span class="view-sub">${subtitle()}</span></div>
      <div class="range-picker">
        ${[7, 30, 90, 365].map((d) => `<button data-range="${d}" class="${d === rangeDays ? 'active' : ''}">${d === 365 ? '1y' : d + 'd'}</button>`).join('')}
      </div>
    </header>
    <div id="flow-kpis" class="kpi-row"></div>
    <div class="flow-section flow-strip-section">
      <div class="section-label">Activity <span class="section-note">opened vs merged, weekly</span></div>
      <div id="flow-strip"></div>
    </div>
    <div class="flow-section">
      <div class="section-label">Work mix</div>
      <div id="flow-mix"></div>
    </div>
    <div class="flow-section">
      <div class="section-label">People</div>
      <div id="flow-people"></div>
    </div>
    <div class="flow-section">
      <div class="section-label">Waste &amp; friction</div>
      <div id="flow-waste" class="waste-row"></div>
    </div>
  `
}

async function loadAndRender() {
  const view = document.getElementById('view-flow')!
  try {
    const res = await fetch(`/api/cache/flow?range=${rangeDays}`)
    if (!res.ok) throw new Error(`Cache ${res.status}`)
    const data: FlowPayload = await res.json()

    const kpis = data.kpis
    const kpisHtml =
      kpiTile('Cycle time', fmtDays(kpis.cycle_time_days_median), delta(kpis.cycle_time_days_median, kpis.cycle_time_days_prev, 'down')) +
      kpiTile('Throughput', `${fmtNum(kpis.throughput_per_month)}/mo`, delta(kpis.throughput_per_month, kpis.throughput_per_month_prev, 'up')) +
      kpiTile('First review', fmtHours(kpis.first_review_hours_median), delta(kpis.first_review_hours_median, kpis.first_review_hours_prev, 'down')) +
      kpiTile('Waste', fmtPct(kpis.waste_pct), delta(kpis.waste_pct, kpis.waste_pct_prev, 'down'))

    view.querySelector('#flow-kpis')!.innerHTML = kpisHtml
    view.querySelector('#flow-strip')!.innerHTML = renderFlowStrip(data.flow_weekly)
    view.querySelector('#flow-mix')!.innerHTML = renderWorkMix(data.work_mix)
    view.querySelector('#flow-people')!.innerHTML = renderPeople(data.people)
    view.querySelector('#flow-waste')!.innerHTML = renderWaste(data.waste_monthly)
  } catch (err) {
    view.innerHTML = `<div class="flow-error">Error loading flow data: ${escapeHtml((err as Error).message)}</div>`
  }
}

export function initFlowView() {
  const view = document.getElementById('view-flow')!
  if (!initialized) {
    initialized = true
    view.innerHTML = renderShell()
    // Range selector
    view.querySelector('#flow-header')!.addEventListener('click', (e) => {
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
