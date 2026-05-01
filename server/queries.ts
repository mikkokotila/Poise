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
