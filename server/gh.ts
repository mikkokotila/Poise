// Bridge from Poise's /api/gh body shape to the github-datastore CLI.
//
// The CLI is shelled out per request (~125ms worst-case for the fattest
// query, sub-100ms for the typical filtered ones — plenty fast for refresh
// ticks). Response shape stays identical to the old /github service so the
// views don't have to change.
//
// Involvement scope: when settings.me is configured, we route through
// `views.user --username <me>` so the lanes show "things I'm involved in"
// — matches Poise's long-standing semantics. Without `me`, fall back to
// org-wide `views.{pr,issue}` so a fresh install isn't blank.
//
// Writes (open_issue, post_comment) aren't supported by github-datastore
// — it's a read-only consumer view of GitHub. We return 501 so the
// frontend's existing error handling kicks in.
//
// Reference: see Vaquum GitHub Datastore Consumer Contract.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getMeta } from './db'

const execFileP = promisify(execFile)
const CLI = 'github-datastore'

// Subset of fields the datastore returns. Pr-only and issue-only fields
// are optional; the user-footprint view adds `item_type` and `reasons`.
interface DatastoreRecord {
  repo: string
  number: number
  status: 'open' | 'closed' | 'merged'
  author: string
  updated_at: string
  created_at: string
  closed_at: string | null
  title: string
  url: string
  comments_count: number
  // PR-only
  pr_ref?: number
  diff_ref?: number
  payload_ref?: number
  review_comments_count?: number
  commits_count?: number
  // Issue-only
  issue_ref?: number
  // user-footprint-only
  username?: string
  item_type?: 'pr' | 'issue'
  reasons?: string
  evidence_count?: number
}

// What Poise's views consume. Kept identical to the old /github shape so
// nothing in src/ needs to change. Fields the datastore doesn't expose
// (labels, owner_*, last_commenter*, author_avatar) are nulled out and
// the views degrade gracefully — author becomes the "last" voice on a
// thread, the avatar falls back to github.com/<username>.png, the
// status column defaults to "In review", etc.
interface GhRecord {
  kind: 'pr' | 'issue'
  repo: string
  number: number
  state: 'open' | 'closed' | 'merged'
  title: string
  url: string
  created_at: string
  updated_at: string
  author: string
  author_avatar: string | null
  merged_at: string | null
  comments_count: number
  last_commenter: string | null
  last_commenter_avatar: string | null
  last_comment_body: string | null
  labels: string[]
  owner_login: string | null
  owner_avatar: string | null
}

async function runCli(args: string[]): Promise<DatastoreRecord[]> {
  const { stdout } = await execFileP(CLI, args, { maxBuffer: 32 * 1024 * 1024 })
  const trimmed = stdout.trim()
  if (!trimmed) return []
  return JSON.parse(trimmed)
}

function toLegacy(r: DatastoreRecord, kind: 'pr' | 'issue'): GhRecord {
  return {
    kind,
    repo: r.repo,
    number: r.number,
    state: r.status,
    title: r.title,
    url: r.url,
    created_at: r.created_at,
    updated_at: r.updated_at,
    author: r.author,
    author_avatar: null,
    merged_at: r.status === 'merged' ? r.closed_at : null,
    comments_count: r.comments_count ?? 0,
    last_commenter: null,
    last_commenter_avatar: null,
    last_comment_body: null,
    labels: [],
    owner_login: null,
    owner_avatar: null,
  }
}

// One CLI call for one kind. The datastore CLI doesn't support offset
// or `q` or `updated_until`, so we pull a wider window than the caller
// asked for whenever those proxy-side filters or count_only are in play
// — otherwise the slice happens before the filter and we wrongly return
// few-or-zero results. The full user-footprint view tops out around
// ~1200 rows and the CLI does that under 150ms, so a generous ceiling
// is cheap.
async function fetchKind(itemType: 'pr' | 'issue', body: any, me: string): Promise<GhRecord[]> {
  const args: string[] = ['view']
  if (me) {
    args.push('user', '--username', me, '--item-type', itemType)
  } else {
    args.push(itemType)
  }
  if (body.record_state === 'open') args.push('--status', 'open')
  if (body.updated_since)            args.push('--updated-since-datetime', body.updated_since)

  const needsWide = !!(body.q || body.updated_until || body.count_only)
  const want = needsWide
    ? 5000
    : (Number(body.offset) || 0) + (Number(body.limit) || 200)
  args.push('--limit', String(Math.min(Math.max(want, 1), 5000)))
  args.push('--format', 'json')

  const recs = await runCli(args)
  return recs.map((r) => toLegacy(r, itemType))
}

export async function handleGhBody(body: any): Promise<{ status: number, body: unknown }> {
  const op = body?.operation
  const me = getMeta('me') || ''

  if (op === 'list') {
    let records: GhRecord[]
    const recordType = body.record_type
    if (recordType === 'pull_request') {
      records = await fetchKind('pr', body, me)
    } else if (recordType === 'issue') {
      records = await fetchKind('issue', body, me)
    } else {
      // 'all' or undefined — both kinds, merged and re-sorted by updated_at desc.
      const [prs, issues] = await Promise.all([
        fetchKind('pr', body, me),
        fetchKind('issue', body, me),
      ])
      records = [...prs, ...issues].sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    }

    // Filters the CLI doesn't support — applied in the proxy.
    if (body.updated_until) {
      const cutoff = String(body.updated_until)
      records = records.filter((r) => r.updated_at < cutoff)
    }
    if (body.q && typeof body.q === 'string') {
      const q = body.q.toLowerCase()
      records = records.filter((r) =>
        r.title.toLowerCase().includes(q) ||
        r.repo.toLowerCase().includes(q) ||
        String(r.number).includes(q) ||
        (r.author || '').toLowerCase().includes(q)
      )
    }

    if (body.count_only) {
      return { status: 200, body: { count: records.length } }
    }

    const offset = Math.max(0, Number(body.offset) || 0)
    const limit = Math.max(0, Number(body.limit) || records.length)
    return { status: 200, body: { records: records.slice(offset, offset + limit) } }
  }

  if (op === 'green_pr') {
    // Mergeability isn't exposed by the datastore — feature soft-disabled.
    // Returning an empty record set keeps Current's fetchPrStatus a no-op
    // rather than an error; if a separate "green" signal is wired later,
    // we plug it in here.
    return { status: 200, body: { records: [] } }
  }

  if (op === 'open_issue' || op === 'post_comment') {
    return {
      status: 501,
      body: { error: `${op} not available — github-datastore is read-only; writes need a separate service` },
    }
  }

  return { status: 400, body: { error: 'unknown operation: ' + String(op) } }
}
