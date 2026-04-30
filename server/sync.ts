import { db, getMeta, setMeta } from './db'

const GITHUB_API = 'https://api.github.com'

// Conventional commit tag parser: "feat: ...", "fix(scope): ..."
const TAG_RE = /^(feat|fix|chore|refactor|docs|test|style|perf|build|ci|revert)(?:\([^)]*\))?:/i

function extractTag(title: string): string | null {
  const m = title.match(TAG_RE)
  return m ? m[1].toLowerCase() : null
}

interface GitHubSearchItem {
  id: number
  number: number
  title: string
  html_url: string
  user: { login: string; avatar_url?: string }
  state: string
  created_at: string
  updated_at: string
  closed_at: string | null
  pull_request?: { merged_at: string | null }
  repository_url: string
  comments: number
  labels?: Array<{ name: string }>
  assignees?: Array<{ login: string; avatar_url?: string }>
}

function computeStatus(labels: Array<{ name: string }> | undefined): 'ALLOCATED' | 'BUILDING' | 'IN REVIEW' {
  if (!labels || labels.length === 0) return 'IN REVIEW'
  const names = new Set(labels.map((l) => l.name))
  // IN_PROGRESS is the later workflow stage — when both are set (allocated and
  // now actively being built) the build state takes precedence.
  if (names.has('IN_PROGRESS')) return 'BUILDING'
  if (names.has('ALLOCATION')) return 'ALLOCATED'
  return 'IN REVIEW'
}

function repoFromUrl(url: string): string {
  return url.split('/').pop() || ''
}

async function ghFetch(path: string, token: string): Promise<any> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'poise',
      Accept: 'application/vnd.github+json',
    },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`GitHub ${res.status}: ${text.slice(0, 200)}`)
  }
  return res.json()
}

async function searchIssues(org: string, me: string, token: string, since?: string): Promise<GitHubSearchItem[]> {
  const all: GitHubSearchItem[] = []
  let q = `org:${org} involves:${me}`
  if (since) q += ` updated:>${since}`

  for (let page = 1; page <= 10; page++) {
    const url = `/search/issues?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=100&page=${page}`
    const data = await ghFetch(url, token)
    all.push(...(data.items as GitHubSearchItem[]))
    if (data.items.length < 100 || all.length >= data.total_count) break
    // Gentle pause between pages
    await new Promise((r) => setTimeout(r, 400))
  }
  return all
}

async function fetchPrDetail(owner: string, repo: string, number: number, token: string): Promise<any> {
  try {
    return await ghFetch(`/repos/${owner}/${repo}/pulls/${number}`, token)
  } catch {
    return null
  }
}

async function fetchReviews(owner: string, repo: string, number: number, token: string): Promise<any[]> {
  try {
    const reviews = await ghFetch(`/repos/${owner}/${repo}/pulls/${number}/reviews?per_page=100`, token)
    return reviews || []
  } catch {
    return []
  }
}

async function fetchFiles(owner: string, repo: string, number: number, token: string): Promise<any[]> {
  try {
    // GitHub caps at 3000 files; 100 is enough for normal PRs
    const files = await ghFetch(`/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`, token)
    return files || []
  } catch {
    return []
  }
}

// Exclude generated / lock / minified files from hotspots (still stored, just filterable in queries)
export function isJunkFile(path: string): boolean {
  const lower = path.toLowerCase()
  const base = lower.split('/').pop() || lower
  if (base === 'changelog.md' || base === 'changelog' || base.startsWith('changelog.')) return true
  if (lower.endsWith('-lock.json') || lower.endsWith('-lock.yaml') || lower.endsWith('.lock')) return true
  if (lower.endsWith('package-lock.json')) return true
  if (lower.endsWith('yarn.lock') || lower.endsWith('pnpm-lock.yaml')) return true
  if (lower.endsWith('cargo.lock') || lower.endsWith('poetry.lock') || lower.endsWith('uv.lock')) return true
  if (lower.endsWith('go.sum')) return true
  if (lower.includes('/node_modules/')) return true
  if (lower.includes('/dist/') || lower.includes('/build/')) return true
  if (lower.endsWith('.min.js') || lower.endsWith('.min.css')) return true
  if (lower.endsWith('.map') || lower.endsWith('.snap')) return true
  return false
}

async function fetchLastComment(owner: string, repo: string, number: number, count: number, token: string): Promise<{ login: string; avatar: string; body: string; createdAt: string } | null> {
  if (count === 0) return null
  try {
    const comments = await ghFetch(`/repos/${owner}/${repo}/issues/${number}/comments?per_page=1&page=${count}`, token)
    if (comments.length > 0) {
      return {
        login: comments[0].user.login,
        avatar: comments[0].user.avatar_url || '',
        body: comments[0].body || '',
        createdAt: comments[0].created_at,
      }
    }
  } catch { /* ignore */ }
  return null
}

// Insert or replace a PR row with all derived fields
const upsertPr = db.prepare(`
  INSERT INTO prs(id, org, repo, number, title, html_url, author, author_avatar, is_pr, state, status,
    owner_login, owner_avatar,
    created_at, updated_at, closed_at, merged_at, comments_count,
    additions, deletions, files_changed, tag, first_review_at, iteration_count,
    last_commenter, last_commenter_avatar, last_comment_body, last_comment_at, raw_json)
  VALUES (@id, @org, @repo, @number, @title, @html_url, @author, @author_avatar, @is_pr, @state, @status,
    @owner_login, @owner_avatar,
    @created_at, @updated_at, @closed_at, @merged_at, @comments_count,
    @additions, @deletions, @files_changed, @tag, @first_review_at, @iteration_count,
    @last_commenter, @last_commenter_avatar, @last_comment_body, @last_comment_at, @raw_json)
  ON CONFLICT(id) DO UPDATE SET
    state=excluded.state,
    status=excluded.status,
    owner_login=excluded.owner_login,
    owner_avatar=excluded.owner_avatar,
    updated_at=excluded.updated_at,
    closed_at=excluded.closed_at,
    merged_at=excluded.merged_at,
    comments_count=excluded.comments_count,
    additions=excluded.additions,
    deletions=excluded.deletions,
    files_changed=excluded.files_changed,
    tag=excluded.tag,
    first_review_at=excluded.first_review_at,
    iteration_count=excluded.iteration_count,
    last_commenter=excluded.last_commenter,
    last_commenter_avatar=excluded.last_commenter_avatar,
    last_comment_body=excluded.last_comment_body,
    last_comment_at=excluded.last_comment_at,
    author_avatar=excluded.author_avatar,
    raw_json=excluded.raw_json
`)

const updateLastCommentOnly = db.prepare(`
  UPDATE prs SET last_commenter = ?, last_commenter_avatar = ?, last_comment_body = ?, last_comment_at = ?
  WHERE id = ?
`)

const deleteReviewsForPr = db.prepare('DELETE FROM reviews WHERE pr_id = ?')
const insertReview = db.prepare(`
  INSERT OR IGNORE INTO reviews(id, pr_id, reviewer, state, submitted_at)
  VALUES (?, ?, ?, ?, ?)
`)

const deleteFilesForPr = db.prepare('DELETE FROM pr_files WHERE pr_id = ?')
const insertFile = db.prepare(`
  INSERT OR REPLACE INTO pr_files(pr_id, filename, additions, deletions)
  VALUES (?, ?, ?, ?)
`)
const updateFilesChanged = db.prepare('UPDATE prs SET files_changed = ? WHERE id = ?')

// Concurrency limiter
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++
      out[idx] = await fn(items[idx])
    }
  })
  await Promise.all(workers)
  return out
}

export interface BackfillResult {
  filled: number
  skipped: number
  remaining: number
  completed_at: string
}

export async function backfillFiles(org: string, token: string, limit: number = 200): Promise<BackfillResult> {
  const rows = db.prepare(`
    SELECT id, repo, number FROM prs
    WHERE is_pr = 1 AND files_changed IS NULL
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(limit) as { id: number; repo: string; number: number }[]

  let filled = 0
  let skipped = 0

  const results = await mapLimit(rows, 6, async (r) => {
    const files = await fetchFiles(org, r.repo, r.number, token)
    return { id: r.id, files }
  })

  const applyAll = db.transaction((items: typeof results) => {
    for (const { id, files } of items) {
      if (files.length === 0) {
        // Still mark as processed so we don't re-fetch forever
        updateFilesChanged.run(0, id)
        skipped++
        continue
      }
      deleteFilesForPr.run(id)
      for (const f of files) insertFile.run(id, f.filename, f.additions || 0, f.deletions || 0)
      updateFilesChanged.run(files.length, id)
      filled++
    }
  })
  applyAll(results)

  const remaining = (db.prepare(`SELECT COUNT(*) AS n FROM prs WHERE is_pr = 1 AND files_changed IS NULL`).get() as { n: number }).n
  return { filled, skipped, remaining, completed_at: new Date().toISOString() }
}

// Re-fetch the last comment for PRs whose last_commenter is set but avatar is missing.
// This catches rows synced before we started storing avatar_url.
export async function backfillAvatars(org: string, token: string, limit: number = 200): Promise<BackfillResult> {
  const rows = db.prepare(`
    SELECT id, repo, number, comments_count FROM prs
    WHERE last_commenter IS NOT NULL AND last_commenter != ''
      AND (last_commenter_avatar IS NULL OR last_commenter_avatar = '')
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(limit) as { id: number; repo: string; number: number; comments_count: number }[]

  let filled = 0
  let skipped = 0

  const results = await mapLimit(rows, 6, async (r) => {
    const c = await fetchLastComment(org, r.repo, r.number, r.comments_count, token)
    return { id: r.id, c }
  })

  const applyAll = db.transaction((items: typeof results) => {
    for (const { id, c } of items) {
      if (!c || !c.avatar) {
        skipped++
        continue
      }
      updateLastCommentOnly.run(c.login, c.avatar, c.body, c.createdAt, id)
      filled++
    }
  })
  applyAll(results)

  const remaining = (db.prepare(`
    SELECT COUNT(*) AS n FROM prs
    WHERE last_commenter IS NOT NULL AND last_commenter != ''
      AND (last_commenter_avatar IS NULL OR last_commenter_avatar = '')
  `).get() as { n: number }).n
  return { filled, skipped, remaining, completed_at: new Date().toISOString() }
}

export interface SyncResult {
  added: number
  updated: number
  total_in_db: number
  since: string | null
  completed_at: string
}

export async function syncDelta(org: string, me: string, token: string, force: boolean = false): Promise<SyncResult> {
  if (!org || !me) throw new Error('org and me must be configured in Settings before syncing')
  const startedAt = new Date().toISOString()
  const lastSync = force ? null : getMeta('last_sync_at')

  // Fetch only items updated since last sync (or all on first run)
  const sinceIso = lastSync ? lastSync.split('.')[0].replace('Z', '') : undefined
  const items = await searchIssues(org, me, token, sinceIso)

  let added = 0
  let updated = 0

  // Enrich PRs in parallel (detail + reviews)
  const enriched = await mapLimit(items, 6, async (item) => {
    const repo = repoFromUrl(item.repository_url)
    const isPR = !!item.pull_request
    const tag = extractTag(item.title)

    let additions: number | undefined
    let deletions: number | undefined
    let filesChanged: number | undefined
    let mergedAt: string | null = item.pull_request?.merged_at || null
    let firstReviewAt: string | null = null
    let iterationCount = 0
    let reviewRows: { id: number; pr_id: number; reviewer: string; state: string; submitted_at: string }[] = []
    let fileRows: { pr_id: number; filename: string; additions: number; deletions: number }[] = []

    if (isPR) {
      const [detail, reviews, files] = await Promise.all([
        fetchPrDetail(org, repo, item.number, token),
        fetchReviews(org, repo, item.number, token),
        fetchFiles(org, repo, item.number, token),
      ])
      if (detail) {
        additions = detail.additions
        deletions = detail.deletions
        mergedAt = detail.merged_at
      }
      const sorted = reviews.slice().sort((a: any, b: any) => a.submitted_at.localeCompare(b.submitted_at))
      if (sorted.length > 0) firstReviewAt = sorted[0].submitted_at
      iterationCount = sorted.filter((r: any) => r.state === 'CHANGES_REQUESTED').length
      reviewRows = sorted.map((r: any) => ({
        id: r.id,
        pr_id: item.id,
        reviewer: r.user?.login || 'unknown',
        state: r.state,
        submitted_at: r.submitted_at,
      }))
      filesChanged = files.length
      fileRows = files.map((f: any) => ({
        pr_id: item.id,
        filename: f.filename,
        additions: f.additions || 0,
        deletions: f.deletions || 0,
      }))
    }

    const lastComment = await fetchLastComment(org, repo, item.number, item.comments, token)

    return {
      row: {
        id: item.id,
        org,
        repo,
        number: item.number,
        title: item.title,
        html_url: item.html_url,
        author: item.user.login,
        author_avatar: item.user.avatar_url || null,
        is_pr: isPR ? 1 : 0,
        state: item.state,
        status: computeStatus(item.labels),
        owner_login: item.assignees?.[0]?.login ?? null,
        owner_avatar: item.assignees?.[0]?.avatar_url ?? null,
        created_at: item.created_at,
        updated_at: item.updated_at,
        closed_at: item.closed_at,
        merged_at: mergedAt,
        comments_count: item.comments,
        additions: additions ?? null,
        deletions: deletions ?? null,
        files_changed: filesChanged ?? null,
        tag,
        first_review_at: firstReviewAt,
        iteration_count: iterationCount,
        last_commenter: lastComment?.login ?? null,
        last_commenter_avatar: lastComment?.avatar ?? null,
        last_comment_body: lastComment?.body ?? null,
        last_comment_at: lastComment?.createdAt ?? null,
        raw_json: JSON.stringify(item),
      },
      reviews: reviewRows,
      files: fileRows,
    }
  })

  // Bulk insert in a transaction
  const insertAll = db.transaction((rows: typeof enriched) => {
    const checkExisting = db.prepare('SELECT id FROM prs WHERE id = ?')
    for (const { row, reviews, files } of rows) {
      const exists = checkExisting.get(row.id)
      if (exists) updated++
      else added++
      upsertPr.run(row)
      if (reviews.length > 0) {
        deleteReviewsForPr.run(row.id)
        for (const r of reviews) insertReview.run(r.id, r.pr_id, r.reviewer, r.state, r.submitted_at)
      }
      if (files.length > 0) {
        deleteFilesForPr.run(row.id)
        for (const f of files) insertFile.run(f.pr_id, f.filename, f.additions, f.deletions)
      }
    }
  })
  insertAll(enriched)

  setMeta('last_sync_at', startedAt)

  const total = (db.prepare('SELECT COUNT(*) as n FROM prs').get() as { n: number }).n
  return {
    added,
    updated,
    total_in_db: total,
    since: sinceIso || null,
    completed_at: new Date().toISOString(),
  }
}
