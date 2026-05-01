import { db } from './db'
import { isJunkFile } from './sync'

export interface PrRow {
  id: number
  repo: string
  number: number
  title: string
  html_url: string
  author: string
  author_avatar: string | null
  is_pr: number
  state: string
  status: string | null
  owner_login: string | null
  owner_avatar: string | null
  created_at: string
  updated_at: string
  closed_at: string | null
  merged_at: string | null
  comments_count: number
  last_commenter: string | null
  last_commenter_avatar: string | null
  last_comment_body: string | null
}

export interface PrListArgs {
  type: 'both' | 'issue' | 'pr'
  status: 'all' | 'open'
  since?: string
  until?: string
  q?: string                       // free-text filter (title / repo / author)
  limit: number
  offset: number
}

function buildPrWhere(args: Pick<PrListArgs, 'type' | 'status' | 'since' | 'until' | 'q'>): { where: string[]; params: any[] } {
  const where: string[] = []
  const params: any[] = []
  if (args.type === 'issue') where.push('is_pr = 0')
  else if (args.type === 'pr') where.push('is_pr = 1')
  if (args.status === 'open') where.push("state = 'open'")
  if (args.since) { where.push('updated_at >= ?'); params.push(args.since) }
  if (args.until) { where.push('updated_at < ?'); params.push(args.until) }
  if (args.q) {
    // Match against title, repo, author — covers what someone is most likely
    // typing into a "filter…" box. Case-insensitive courtesy of LIKE on a
    // SQLite TEXT column with default NOCASE-friendly inputs.
    const like = `%${args.q.replace(/[%_\\]/g, (m) => '\\' + m)}%`
    where.push(`(title LIKE ? ESCAPE '\\' OR repo LIKE ? ESCAPE '\\' OR author LIKE ? ESCAPE '\\')`)
    params.push(like, like, like)
  }
  return { where, params }
}

export function listPrs(args: PrListArgs): PrRow[] {
  const { where, params } = buildPrWhere(args)
  const sql = `
    SELECT id, repo, number, title, html_url, author, author_avatar, is_pr, state, status,
           owner_login, owner_avatar,
           created_at, updated_at, closed_at, merged_at, comments_count,
           last_commenter, last_commenter_avatar, last_comment_body
    FROM prs
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY updated_at DESC
    LIMIT ? OFFSET ?
  `
  return db.prepare(sql).all(...params, args.limit, args.offset) as PrRow[]
}

export function countPrs(args: Omit<PrListArgs, 'limit' | 'offset'>): number {
  const { where, params } = buildPrWhere(args)
  const sql = `SELECT COUNT(*) as n FROM prs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`
  return (db.prepare(sql).get(...params) as { n: number }).n
}

// Dashboard data — takes a date range (days back from now)
export interface FlowPayload {
  range_days: number
  now: string
  total_prs: number
  kpis: {
    cycle_time_days_median: number | null
    cycle_time_days_prev: number | null
    throughput_per_month: number
    throughput_per_month_prev: number
    first_review_hours_median: number | null
    first_review_hours_prev: number | null
    waste_pct: number
    waste_pct_prev: number
  }
  flow_weekly: Array<{ week: string; opened: number; merged: number }>
  work_mix: Array<{ tag: string; count: number }>
  people: Array<{ author: string; prs: number; reviews: number; comments: number; merge_rate: number }>
  waste_monthly: Array<{ month: string; stale: number; wasted_reviews: number; abandoned: number }>
}

function daysAgo(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString()
}

function medianNumbers(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = values.slice().sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function cycleTimeDays(prWhere: string, params: any[]): number | null {
  const rows = db.prepare(`
    SELECT created_at, merged_at FROM prs
    WHERE is_pr = 1 AND merged_at IS NOT NULL ${prWhere ? `AND ${prWhere}` : ''}
  `).all(...params) as { created_at: string; merged_at: string }[]
  const ds = rows.map((r) => (new Date(r.merged_at).getTime() - new Date(r.created_at).getTime()) / 86400000)
  return medianNumbers(ds)
}

function firstReviewHours(prWhere: string, params: any[]): number | null {
  const rows = db.prepare(`
    SELECT created_at, first_review_at FROM prs
    WHERE is_pr = 1 AND first_review_at IS NOT NULL ${prWhere ? `AND ${prWhere}` : ''}
  `).all(...params) as { created_at: string; first_review_at: string }[]
  const hs = rows.map((r) => (new Date(r.first_review_at).getTime() - new Date(r.created_at).getTime()) / 3600000)
  return medianNumbers(hs)
}

function throughputPerMonth(prWhere: string, params: any[], days: number): number {
  const row = db.prepare(`
    SELECT COUNT(*) as n FROM prs
    WHERE is_pr = 1 AND merged_at IS NOT NULL ${prWhere ? `AND ${prWhere}` : ''}
  `).get(...params) as { n: number }
  return (row.n / days) * 30
}

function wastePct(since: string, until: string | null): { waste: number; total: number } {
  // Wasted = PRs closed without merge (is_pr=1, closed_at != null, merged_at = null) in the window
  // Rate = wasted / (merged + wasted)
  const untilClause = until ? 'AND closed_at < ?' : ''
  const params: any[] = [since]
  if (until) params.push(until)
  const wasted = (db.prepare(`
    SELECT COUNT(*) as n FROM prs
    WHERE is_pr = 1 AND merged_at IS NULL AND closed_at IS NOT NULL AND closed_at >= ? ${untilClause}
  `).get(...params) as { n: number }).n
  const merged = (db.prepare(`
    SELECT COUNT(*) as n FROM prs
    WHERE is_pr = 1 AND merged_at IS NOT NULL AND merged_at >= ? ${until ? 'AND merged_at < ?' : ''}
  `).get(...params) as { n: number }).n
  const total = wasted + merged
  return { waste: total === 0 ? 0 : (wasted / total) * 100, total }
}

export function getFlow(rangeDays: number): FlowPayload {
  const now = new Date()
  const since = daysAgo(rangeDays)
  const prevSince = daysAgo(rangeDays * 2)
  const prevUntil = since

  // ── KPIs ──
  const cycleNow = cycleTimeDays('merged_at >= ?', [since])
  const cyclePrev = cycleTimeDays('merged_at >= ? AND merged_at < ?', [prevSince, prevUntil])

  const thruNow = throughputPerMonth('merged_at >= ?', [since], rangeDays)
  const thruPrev = throughputPerMonth('merged_at >= ? AND merged_at < ?', [prevSince, prevUntil], rangeDays)

  const firstNow = firstReviewHours('created_at >= ?', [since])
  const firstPrev = firstReviewHours('created_at >= ? AND created_at < ?', [prevSince, prevUntil])

  const waste = wastePct(since, null)
  const wastePrev = wastePct(prevSince, prevUntil)

  // ── Flow strip (weekly opened vs merged) ──
  const openedByWeek = db.prepare(`
    SELECT strftime('%Y-%W', created_at) AS week, COUNT(*) AS n
    FROM prs WHERE is_pr = 1 AND created_at >= ?
    GROUP BY week ORDER BY week
  `).all(since) as { week: string; n: number }[]
  const mergedByWeek = db.prepare(`
    SELECT strftime('%Y-%W', merged_at) AS week, COUNT(*) AS n
    FROM prs WHERE is_pr = 1 AND merged_at IS NOT NULL AND merged_at >= ?
    GROUP BY week ORDER BY week
  `).all(since) as { week: string; n: number }[]

  const weekMap = new Map<string, { opened: number; merged: number }>()
  for (const o of openedByWeek) weekMap.set(o.week, { opened: o.n, merged: 0 })
  for (const m of mergedByWeek) {
    const e = weekMap.get(m.week) || { opened: 0, merged: 0 }
    e.merged = m.n
    weekMap.set(m.week, e)
  }
  const flow_weekly = Array.from(weekMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, v]) => ({ week, ...v }))

  // ── Work mix ──
  const work_mix = db.prepare(`
    SELECT COALESCE(tag, 'other') AS tag, COUNT(*) AS count
    FROM prs WHERE is_pr = 1 AND created_at >= ?
    GROUP BY tag ORDER BY count DESC
  `).all(since) as { tag: string; count: number }[]

  // ── People ──
  const peopleRows = db.prepare(`
    SELECT author,
           SUM(CASE WHEN is_pr = 1 THEN 1 ELSE 0 END) AS prs,
           SUM(CASE WHEN is_pr = 1 AND merged_at IS NOT NULL THEN 1 ELSE 0 END) AS merged,
           SUM(comments_count) AS comments
    FROM prs WHERE created_at >= ?
    GROUP BY author
    HAVING prs > 0
    ORDER BY prs DESC LIMIT 8
  `).all(since) as { author: string; prs: number; merged: number; comments: number }[]

  const reviewsByAuthor = db.prepare(`
    SELECT reviewer, COUNT(*) AS n FROM reviews
    WHERE submitted_at >= ?
    GROUP BY reviewer
  `).all(since) as { reviewer: string; n: number }[]
  const reviewMap = new Map(reviewsByAuthor.map((r) => [r.reviewer, r.n]))

  const people = peopleRows.map((p) => ({
    author: p.author,
    prs: p.prs,
    reviews: reviewMap.get(p.author) || 0,
    comments: p.comments,
    merge_rate: p.prs === 0 ? 0 : (p.merged / p.prs) * 100,
  }))

  // ── Waste & friction (monthly) ──
  const monthlyStale = db.prepare(`
    SELECT strftime('%Y-%m', updated_at) AS month, COUNT(*) AS n
    FROM prs
    WHERE is_pr = 1 AND state = 'open' AND updated_at >= ?
      AND julianday('now') - julianday(updated_at) > 30
    GROUP BY month ORDER BY month
  `).all(since) as { month: string; n: number }[]
  const monthlyWasted = db.prepare(`
    SELECT strftime('%Y-%m', closed_at) AS month, COUNT(*) AS n
    FROM prs
    WHERE is_pr = 1 AND merged_at IS NULL AND closed_at IS NOT NULL AND closed_at >= ?
    GROUP BY month ORDER BY month
  `).all(since) as { month: string; n: number }[]
  const monthlyAbandoned = db.prepare(`
    SELECT strftime('%Y-%m', updated_at) AS month, COUNT(*) AS n
    FROM prs
    WHERE is_pr = 1 AND state = 'open' AND updated_at >= ?
      AND julianday('now') - julianday(updated_at) > 60
    GROUP BY month ORDER BY month
  `).all(since) as { month: string; n: number }[]

  const monthSet = new Set<string>([
    ...monthlyStale.map((m) => m.month),
    ...monthlyWasted.map((m) => m.month),
    ...monthlyAbandoned.map((m) => m.month),
  ])
  const staleMap = new Map(monthlyStale.map((m) => [m.month, m.n]))
  const wastedMap = new Map(monthlyWasted.map((m) => [m.month, m.n]))
  const abandonedMap = new Map(monthlyAbandoned.map((m) => [m.month, m.n]))

  const waste_monthly = Array.from(monthSet).sort().map((month) => ({
    month,
    stale: staleMap.get(month) || 0,
    wasted_reviews: wastedMap.get(month) || 0,
    abandoned: abandonedMap.get(month) || 0,
  }))

  const total_prs = (db.prepare('SELECT COUNT(*) as n FROM prs').get() as { n: number }).n

  return {
    range_days: rangeDays,
    now: now.toISOString(),
    total_prs,
    kpis: {
      cycle_time_days_median: cycleNow,
      cycle_time_days_prev: cyclePrev,
      throughput_per_month: thruNow,
      throughput_per_month_prev: thruPrev,
      first_review_hours_median: firstNow,
      first_review_hours_prev: firstPrev,
      waste_pct: waste.waste,
      waste_pct_prev: wastePrev.waste,
    },
    flow_weekly,
    work_mix,
    people,
    waste_monthly,
  }
}

// ──────────────────────────────────────────────────────────────────
// TRUST — rework, silent merges, bounce, blast, hotspots
// ──────────────────────────────────────────────────────────────────

export interface TrustPayload {
  range_days: number
  now: string
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
  rework_weekly: Array<{ week: string; feat: number; fix: number; other: number }>
  engagement: Array<{ bucket: string; count: number; pct: number }>
  iteration_buckets: Array<{ bucket: string; count: number; pct: number }>
  hotspots: Array<{ filename: string; prs: number; loc: number; last: string }>
  files_coverage_pct: number
}

function fixReworkPct(sinceWhere: string, params: any[]): { rework: number; merged: number; tagged: number } {
  const merged = (db.prepare(`
    SELECT COUNT(*) AS n FROM prs
    WHERE is_pr = 1 AND merged_at IS NOT NULL ${sinceWhere}
  `).get(...params) as { n: number }).n
  const fix = (db.prepare(`
    SELECT COUNT(*) AS n FROM prs
    WHERE is_pr = 1 AND merged_at IS NOT NULL
      AND (tag IN ('fix', 'revert') OR title LIKE 'revert%')
      ${sinceWhere}
  `).get(...params) as { n: number }).n
  const tagged = (db.prepare(`
    SELECT COUNT(*) AS n FROM prs
    WHERE is_pr = 1 AND merged_at IS NOT NULL AND tag IS NOT NULL ${sinceWhere}
  `).get(...params) as { n: number }).n
  return { rework: merged === 0 ? 0 : (fix / merged) * 100, merged, tagged }
}

function silentMergePct(sinceWhere: string, params: any[]): number {
  // Silent = merged PR with ZERO reviews from someone other than the author
  // AND zero issue comments (approximation — issue comments include author self-comments though)
  const merged = db.prepare(`
    SELECT id, author, comments_count FROM prs
    WHERE is_pr = 1 AND merged_at IS NOT NULL ${sinceWhere}
  `).all(...params) as { id: number; author: string; comments_count: number }[]
  if (merged.length === 0) return 0

  const reviewsByPr = db.prepare(`
    SELECT pr_id, reviewer FROM reviews WHERE pr_id IN (${merged.map(() => '?').join(',')})
  `).all(...merged.map((m) => m.id)) as { pr_id: number; reviewer: string }[]
  const peerReviewMap = new Map<number, boolean>()
  for (const m of merged) peerReviewMap.set(m.id, false)
  for (const r of reviewsByPr) {
    const pr = merged.find((p) => p.id === r.pr_id)
    if (pr && r.reviewer !== pr.author && !/\[bot\]$/i.test(r.reviewer)) {
      peerReviewMap.set(pr.id, true)
    }
  }
  const silent = merged.filter((m) => !peerReviewMap.get(m.id)).length
  return (silent / merged.length) * 100
}

function bounceMean(sinceWhere: string, params: any[]): number {
  const row = db.prepare(`
    SELECT AVG(iteration_count) AS a FROM prs
    WHERE is_pr = 1 AND merged_at IS NOT NULL ${sinceWhere}
  `).get(...params) as { a: number | null }
  return row.a || 0
}

function blastMedianLoc(sinceWhere: string, params: any[]): number {
  const rows = db.prepare(`
    SELECT COALESCE(additions, 0) + COALESCE(deletions, 0) AS loc FROM prs
    WHERE is_pr = 1 AND merged_at IS NOT NULL AND additions IS NOT NULL ${sinceWhere}
  `).all(...params) as { loc: number }[]
  if (rows.length === 0) return 0
  const vals = rows.map((r) => r.loc).sort((a, b) => a - b)
  const mid = Math.floor(vals.length / 2)
  return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2
}

export function getTrust(rangeDays: number): TrustPayload {
  const now = new Date()
  const since = daysAgo(rangeDays)
  const prevSince = daysAgo(rangeDays * 2)
  const prevUntil = since

  const mergedSince = 'AND merged_at >= ?'
  const mergedBetween = 'AND merged_at >= ? AND merged_at < ?'

  const { rework: reworkNow, merged: mergedCountNow, tagged } = fixReworkPct(mergedSince, [since])
  const { rework: reworkPrev } = fixReworkPct(mergedBetween, [prevSince, prevUntil])

  const silentNow = silentMergePct(mergedSince, [since])
  const silentPrev = silentMergePct(mergedBetween, [prevSince, prevUntil])

  const bounceNow = bounceMean(mergedSince, [since])
  const bouncePrev = bounceMean(mergedBetween, [prevSince, prevUntil])

  const blastNow = blastMedianLoc(mergedSince, [since])
  const blastPrev = blastMedianLoc(mergedBetween, [prevSince, prevUntil])

  // Rework trend (weekly: feat vs fix vs other)
  const weekly = db.prepare(`
    SELECT strftime('%Y-%W', merged_at) AS week,
           SUM(CASE WHEN tag = 'feat' THEN 1 ELSE 0 END) AS feat,
           SUM(CASE WHEN tag IN ('fix','revert') OR title LIKE 'revert%' THEN 1 ELSE 0 END) AS fix,
           SUM(CASE WHEN tag IS NOT NULL AND tag NOT IN ('feat','fix','revert') THEN 1 ELSE 0 END)
             + SUM(CASE WHEN tag IS NULL THEN 1 ELSE 0 END) AS other
    FROM prs
    WHERE is_pr = 1 AND merged_at IS NOT NULL AND merged_at >= ?
    GROUP BY week ORDER BY week
  `).all(since) as { week: string; feat: number; fix: number; other: number }[]

  // Engagement buckets (comments per merged PR, non-author approximation)
  const mergedPrs = db.prepare(`
    SELECT comments_count FROM prs
    WHERE is_pr = 1 AND merged_at IS NOT NULL AND merged_at >= ?
  `).all(since) as { comments_count: number }[]
  const engagement = [
    { bucket: '0', count: mergedPrs.filter((p) => p.comments_count === 0).length, pct: 0 },
    { bucket: '1-2', count: mergedPrs.filter((p) => p.comments_count >= 1 && p.comments_count <= 2).length, pct: 0 },
    { bucket: '3-5', count: mergedPrs.filter((p) => p.comments_count >= 3 && p.comments_count <= 5).length, pct: 0 },
    { bucket: '6+', count: mergedPrs.filter((p) => p.comments_count >= 6).length, pct: 0 },
  ]
  const engTotal = engagement.reduce((s, e) => s + e.count, 0) || 1
  engagement.forEach((e) => { e.pct = (e.count / engTotal) * 100 })

  // Iteration buckets
  const mergedIter = db.prepare(`
    SELECT iteration_count FROM prs
    WHERE is_pr = 1 AND merged_at IS NOT NULL AND merged_at >= ?
  `).all(since) as { iteration_count: number }[]
  const iteration_buckets = [
    { bucket: '0', count: mergedIter.filter((p) => p.iteration_count === 0).length, pct: 0 },
    { bucket: '1', count: mergedIter.filter((p) => p.iteration_count === 1).length, pct: 0 },
    { bucket: '2', count: mergedIter.filter((p) => p.iteration_count === 2).length, pct: 0 },
    { bucket: '3+', count: mergedIter.filter((p) => p.iteration_count >= 3).length, pct: 0 },
  ]
  const iterTotal = iteration_buckets.reduce((s, e) => s + e.count, 0) || 1
  iteration_buckets.forEach((e) => { e.pct = (e.count / iterTotal) * 100 })

  // Hotspots — top 10 files by distinct PR count
  const hotspotRows = db.prepare(`
    SELECT pf.filename,
           COUNT(DISTINCT pf.pr_id) AS prs,
           SUM(pf.additions + pf.deletions) AS loc,
           MAX(p.merged_at) AS last
    FROM pr_files pf
    JOIN prs p ON p.id = pf.pr_id
    WHERE p.merged_at IS NOT NULL AND p.merged_at >= ?
    GROUP BY pf.filename
    ORDER BY prs DESC, loc DESC
  `).all(since) as { filename: string; prs: number; loc: number; last: string }[]
  const hotspots = hotspotRows.filter((h) => !isJunkFile(h.filename)).slice(0, 10)

  // Coverage stats — how confident can the user be in the numbers?
  const tag_coverage_pct = mergedCountNow === 0 ? 0 : (tagged / mergedCountNow) * 100

  const totalPrs = (db.prepare(`SELECT COUNT(*) AS n FROM prs WHERE is_pr = 1`).get() as { n: number }).n
  const filesFilled = (db.prepare(`SELECT COUNT(*) AS n FROM prs WHERE is_pr = 1 AND files_changed IS NOT NULL`).get() as { n: number }).n
  const files_coverage_pct = totalPrs === 0 ? 0 : (filesFilled / totalPrs) * 100

  return {
    range_days: rangeDays,
    now: now.toISOString(),
    kpis: {
      rework_pct: reworkNow,
      rework_pct_prev: reworkPrev,
      silent_pct: silentNow,
      silent_pct_prev: silentPrev,
      bounce_mean: bounceNow,
      bounce_mean_prev: bouncePrev,
      blast_median_loc: blastNow,
      blast_median_loc_prev: blastPrev,
    },
    tag_coverage_pct,
    rework_weekly: weekly,
    engagement,
    iteration_buckets,
    hotspots,
    files_coverage_pct,
  }
}
