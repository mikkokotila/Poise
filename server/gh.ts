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
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getMeta } from './db'

const execFileP = promisify(execFile)
const CLI = 'github-datastore'
const GH_INTERFACE = 'github-interface'
const GH = 'gh'

// Identity the review-agent uses on GitHub — threaded through from
// cachePlugin's opts (Vite's loadEnv populates the plugin options object
// but NOT process.env, so reading process.env.REVIEW_AGENT_USERNAME here
// would silently come back empty — see the same note in
// server/behaviors.ts). Set once at server start by
// setReviewAgentUsername. The involvement scope in fetchKind unions this
// account's *authored* issues/PRs with the configured `me`'s involvement,
// so work the user's own agent opened surfaces in Current as the user's.
let reviewAgentUsername = ''
export function setReviewAgentUsername(name: string): void {
  reviewAgentUsername = String(name || '')
}

// github-interface resolves the repo from cwd's last two path parts when
// no git remote is found. We make a no-op directory under tmpdir for each
// repo and use that as cwd — `mkdir -p` is cheap and idempotent.
const GH_INTERFACE_CWD_ROOT = join(tmpdir(), 'poise-gh-interface')

// PR mergeable cache — once-a-minute poll cadence on the front, ~60s TTL
// here means we do real work on each user-driven tick but skip duplicate
// checks within the tick.
const GREEN_TTL_MS = 60_000
const GREEN_CONCURRENCY = 5
const greenCache = new Map<string, { green: boolean, expiry: number }>()

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
  // PR-only — owner_login/avatar exist on views.pr (currently null
  // until populated upstream); not on views.user yet.
  pr_ref?: number
  diff_ref?: number
  payload_ref?: number
  review_comments_count?: number
  commits_count?: number
  owner_login?: string | null
  owner_avatar?: string | null
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
    owner_login: r.owner_login ?? null,
    owner_avatar: r.owner_avatar ?? null,
  }
}

// Org-wide list of every repo. Used to populate Current's repo
// dropdowns (manual cards + issue composer) — the user picks from the
// entire Vaquum org, not just repos they've personally touched.
// Cached 5 min so the dropdowns open instantly on subsequent edits.
//
// Source is `github-interface --view-repos ORG` — that's where org-
// level metadata belongs. Returns every repo (including ones with no
// PRs or issues), unlike a derivation from views.pr/views.issue.
let repoListCache: { repos: string[], expiry: number } | null = null
const REPO_LIST_TTL_MS = 5 * 60 * 1000

function shortRepo(full: string): string {
  return full.includes('/') ? full.split('/', 2)[1] : full
}

export async function listOrgRepos(): Promise<string[]> {
  const now = Date.now()
  if (repoListCache && repoListCache.expiry > now) return repoListCache.repos

  const me = getMeta('me') || ''
  const org = getMeta('org') || ''
  if (!org) {
    // Without an org configured we can't ask github-interface; return
    // empty so the front-end falls back to the involvement-derived set.
    void me
    return []
  }

  const { stdout } = await execFileP(GH_INTERFACE, ['--view-repos', org], {
    maxBuffer: 32 * 1024 * 1024,
  })
  const data = JSON.parse(stdout)
  const fullNames: string[] = (data.repos || [])
    .map((r: any) => String(r.full_name || ''))
    .filter((s: string) => s.length > 0)
  const repos = fullNames.sort((a, b) => shortRepo(a).localeCompare(shortRepo(b)))
  repoListCache = { repos, expiry: now + REPO_LIST_TTL_MS }
  return repos
}

// Resolve the local checkout path for a repo via
// `github-interface --local-checkout-path ORG REPO`. Returns an absolute
// filesystem path. Used to set --pwd for `agent-interface --pr-review`,
// since the underlying claude run needs the repo's files to read.
export async function localCheckoutPath(owner: string, repo: string): Promise<string> {
  if (!owner || !repo) throw new Error('owner and repo required')
  const { stdout } = await execFileP(GH_INTERFACE, ['--local-checkout-path', owner, repo], {
    maxBuffer: 1 * 1024 * 1024,
  })
  const result = JSON.parse(stdout)
  if (!result.path) throw new Error('github-interface --local-checkout-path returned no path')
  return String(result.path)
}

// Ask github-interface for a PR's current head commit SHA. Used by
// the review-new-prs dedupe key so a force-push (or any new commit)
// is recognised as a fresh target for re-review rather than treated
// as the already-reviewed PR. Single GitHub call, no pagination.
export async function getHeadSha(repo: string, number: number): Promise<string> {
  if (!repo.includes('/')) throw new Error('repo must be owner/name')
  const [owner, name] = repo.split('/', 2)
  const cwd = join(GH_INTERFACE_CWD_ROOT, owner, name)
  await mkdir(cwd, { recursive: true })
  const { stdout } = await execFileP(GH_INTERFACE, ['--head-sha', `#${number}`], {
    cwd,
    maxBuffer: 1 * 1024 * 1024,
  })
  const result = JSON.parse(stdout)
  if (!result.head_sha) throw new Error('github-interface --head-sha returned no head_sha')
  return String(result.head_sha)
}

// Ask github-interface whether a single PR is "green" (mergeable, open,
// not draft, mergeable_state == clean). Cached per PR for ~60s so the
// once-a-minute frontend poll doesn't refire the whole fanout every tick.
//
// github-interface infers the repo from cwd when no `--repository` flag
// or git remote is available. We just point cwd at a tmp directory whose
// last two parts are `<owner>/<repo>` and the CLI picks it up.
async function checkMergeable(owner: string, repo: string, number: number): Promise<boolean> {
  const key = `${owner}/${repo}#${number}`
  const now = Date.now()
  const cached = greenCache.get(key)
  if (cached && cached.expiry > now) return cached.green

  const cwd = join(GH_INTERFACE_CWD_ROOT, owner, repo)
  try {
    await mkdir(cwd, { recursive: true })
    const { stdout } = await execFileP(GH_INTERFACE, ['--mergeable', `#${number}`], {
      cwd,
      maxBuffer: 1 * 1024 * 1024,
    })
    const result = JSON.parse(stdout)
    const green = !!result.mergeable
    greenCache.set(key, { green, expiry: now + GREEN_TTL_MS })
    return green
  } catch {
    // Network blip / API error / parse failure — cache the negative so we
    // don't hammer on every retry. Better to under-show green than to
    // over-show it.
    greenCache.set(key, { green: false, expiry: now + GREEN_TTL_MS })
    return false
  }
}

// Resolve mergeable-true PRs across the user's open-PR set. Concurrency
// capped to be polite to GitHub's REST endpoint — typical involvement
// only has a handful of open PRs at once.
async function fetchGreenPrs(me: string): Promise<{ repo: string, number: number }[]> {
  const openPrs = await fetchKind('pr', { record_state: 'open', limit: 200 }, me)

  const results: { repo: string, number: number }[] = []
  for (let i = 0; i < openPrs.length; i += GREEN_CONCURRENCY) {
    const chunk = openPrs.slice(i, i + GREEN_CONCURRENCY)
    const checks = await Promise.all(chunk.map(async (pr) => {
      if (!pr.repo.includes('/')) return { pr, green: false }
      const [owner, repoName] = pr.repo.split('/', 2)
      const green = await checkMergeable(owner, repoName, pr.number)
      return { pr, green }
    }))
    for (const { pr, green } of checks) {
      if (green) results.push({ repo: pr.repo, number: pr.number })
    }
  }
  return results
}

// One CLI call for one kind. The datastore CLI doesn't support offset
// or `q` or `updated_until`, so we pull a wider window than the caller
// asked for whenever those proxy-side filters or count_only are in play
// — otherwise the slice happens before the filter and we wrongly return
// few-or-zero results. The full user-footprint view tops out around
// ~1200 rows and the CLI does that under 150ms, so a generous ceiling
// is cheap.
async function fetchKind(itemType: 'pr' | 'issue', body: any, me: string): Promise<GhRecord[]> {
  // Scope(s) selecting WHICH records — the leading CLI args that differ
  // per query. The common filters (status / since / limit / format) are
  // appended identically to each scope below.
  //
  // When body.author is set, scope is "PRs/issues authored by X across
  // the org" (uses views.pr / views.issue with --author). The author
  // path lets behaviors target a specific user (e.g. the Poise account)
  // even when the configured `me` is a different user — no agent union.
  //
  // Otherwise scope is "things `me` is involved in" via views.user. The
  // review-agent acts on the user's behalf, so we also union what IT
  // AUTHORED when one is configured and distinct: without this, issues/PRs
  // the agent opened (e.g. bit-mis chores) never surface in Current even
  // though they're the user's work.
  //
  // We use the agent's *authored* set (views.{issue,pr} --author), NOT its
  // involvement view: github-datastore only populates views.user for the
  // configured user, so the agent's involvement comes back empty — and
  // "authored" is the semantic we want anyway (what the agent produced for
  // us, not every PR it merely reviewed). Deduped by repo#number below.
  const scopes: string[][] = []
  if (body.author) {
    scopes.push([itemType, '--author', String(body.author)])
  } else if (me) {
    scopes.push(['user', '--username', me, '--item-type', itemType])
    if (reviewAgentUsername && reviewAgentUsername !== me) {
      scopes.push([itemType, '--author', reviewAgentUsername])
    }
  } else {
    scopes.push([itemType])
  }

  const common: string[] = []
  if (body.record_state === 'open') common.push('--status', 'open')
  if (body.updated_since)            common.push('--updated-since-datetime', body.updated_since)

  const needsWide = !!(body.q || body.updated_until || body.count_only)
  const want = needsWide
    ? 5000
    : (Number(body.offset) || 0) + (Number(body.limit) || 200)
  common.push('--limit', String(Math.min(Math.max(want, 1), 5000)))
  common.push('--format', 'json')

  const batches = await Promise.all(scopes.map((scope) => runCli(['view', ...scope, ...common])))

  // Merge + dedupe by repo#number: the same item can land in both the
  // user's and the agent's involvement (one opened it, the other
  // reviewed). handleGhBody re-sorts by updated_at, so order here is
  // irrelevant — we just keep the first sighting of each record.
  const seen = new Set<string>()
  const out: GhRecord[] = []
  for (const recs of batches) {
    for (const r of recs) {
      const key = `${r.repo}#${r.number}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(toLegacy(r, itemType))
    }
  }
  return out
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
    // Mergeability isn't on the datastore views, so we fan out
    // `github-interface --mergeable '#<n>'` across the user's open PRs.
    // Results are cached ~60s so subsequent ticks within a refresh
    // window are instant.
    const records = await fetchGreenPrs(me)
    return { status: 200, body: { records } }
  }

  if (op === 'open_issue') {
    // User-initiated issue creation — authored as the configured main user
    // (settings.me), NOT the review-agent.
    //
    // We deliberately bypass `github-interface --create-issue`: its
    // create_issue behavior hardcodes TOKEN_USER="bit-mis" (the bot
    // account) with no flag/env/payload override, so every issue it opens
    // is authored by the bot. Current's composer and Editor's "create
    // issue from selection" are the user's OWN actions, so we POST through
    // `gh api` with the token pinned to `me` (gh's stored credential for
    // that account) — making the identity independent of whichever gh
    // account happens to be "active".
    const repoFull = String(body.repository_full_name || '')
    const title = String(body.title || '').trim()
    const issueBody = String(body.body || '').trim()
    if (!repoFull.includes('/')) return { status: 400, body: { error: 'repository_full_name required (org/repo)' } }
    if (!title || !issueBody)    return { status: 400, body: { error: 'title and body are required' } }
    const [owner, repo] = repoFull.split('/', 2)

    // Resolve `me`'s gh credential. With no `me` configured, fall back to
    // gh's active account.
    let token = ''
    try {
      const tokenArgs = ['auth', 'token', ...(me ? ['--user', me] : [])]
      token = (await execFileP(GH, tokenArgs, { maxBuffer: 1 * 1024 * 1024 })).stdout.trim()
      if (!token) throw new Error('empty token')
    } catch (err: any) {
      const msg = err?.stderr?.toString?.() || err?.message || String(err)
      return { status: 502, body: { error: `could not resolve a gh token for ${me || 'the active account'} (run \`gh auth login\` as ${me || 'that user'}): ${msg}` } }
    }

    try {
      // `-f` sends raw string fields (no true/false/number coercion of the
      // title/body); gh switches to POST automatically when fields are set.
      const { stdout } = await execFileP(GH, [
        'api', `repos/${owner}/${repo}/issues`,
        '-f', `title=${title}`,
        '-f', `body=${issueBody}`,
      ], {
        env: { ...process.env, GH_TOKEN: token, GH_HOST: 'github.com' },
        maxBuffer: 4 * 1024 * 1024,
      })
      // gh api returns the full GitHub issue payload at top level. Normalize
      // to a GhRecord so the frontend can splice the new issue straight into
      // liveItems while github-datastore (a polling consumer view) catches
      // up — an immediate refetch wouldn't yet know about the new issue.
      const issue = JSON.parse(stdout)
      const number = Number(issue.number || 0)
      if (!number) {
        return { status: 502, body: { error: 'gh api create issue: missing number in response' } }
      }
      const nowIso = new Date().toISOString()
      const record: GhRecord = {
        kind: 'issue',
        repo: repoFull,
        number,
        state: (issue.state as 'open' | 'closed' | 'merged') || 'open',
        title: String(issue.title || title),
        url: String(issue.html_url || `https://github.com/${repoFull}/issues/${number}`),
        created_at: String(issue.created_at || nowIso),
        updated_at: String(issue.updated_at || issue.created_at || nowIso),
        author: String(issue.user?.login || me || ''),
        author_avatar: issue.user?.avatar_url ? String(issue.user.avatar_url) : null,
        merged_at: null,
        comments_count: 0,
        last_commenter: null,
        last_commenter_avatar: null,
        last_comment_body: null,
        labels: [],
        owner_login: null,
        owner_avatar: null,
      }
      return { status: 200, body: { record } }
    } catch (err: any) {
      let msg = err?.stderr?.toString?.() || err?.message || String(err)
      if (token) msg = msg.split(token).join('***')   // never leak the token in errors
      return { status: 502, body: { error: 'gh api create issue failed: ' + msg } }
    }
  }

  return { status: 400, body: { error: 'unknown operation: ' + String(op) } }
}
