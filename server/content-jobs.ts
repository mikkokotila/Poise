import { randomUUID } from 'node:crypto'
import { link, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fetchAgentLogs, fetchAgentResponse } from './agent'
import {
  authorContentStatus,
  contentSlugForCallId,
  isAuthorContentDiscoveryPendingError,
  normalizeAuthorContentTopic,
  startAuthorContent,
} from './chat'
import {
  CONTENT_LAUNCH_RECOVERY_WATERMARK_KEY,
  CONTENT_LAUNCH_REGISTRATION_TIMEOUT_MS,
  CONTENT_LEGACY_MAPPING_KEY,
  db,
  getMeta,
} from './db'
import { claudeAuth } from './claude-auth'
import { HttpError } from './http'
import { withProcessLock } from './process-lock'

export type ContentJobStatus = 'pending' | 'running' | 'completed' | 'failed'

interface ContentJobRow {
  call_id: string
  session_id: string
  topic: string
  started_at: string
  status: ContentJobStatus
  slug: string
  response_hash: string | null
  error: string | null
  article_created: number
  lease_owner: string | null
  lease_expires_at: number | null
  next_attempt_at: number
  error_count: number
  created_at: string
  updated_at: string
  completed_at: string | null
}

interface ContentLaunchRow {
  launch_id: string
  session_id: string
  topic: string
  requested_at: string
  registration_deadline_at: number
  recovery_eligible: number
  status: 'pending' | 'linked' | 'failed'
  call_id: string | null
  error: string | null
  updated_at: string
}

export class ContentLaunchPendingError extends Error {
  readonly code = 'CONTENT_LAUNCH_PENDING'
  readonly statusCode = 409

  constructor(sessionId: string) {
    super(`an author-content launch is already pending for session ${sessionId}`)
    this.name = 'ContentLaunchPendingError'
  }
}

export interface ContentJob {
  callId: string
  sessionId: string
  topic: string
  startedAt: string
  status: ContentJobStatus
  slug: string
  responseHash: string | null
  error: string | null
  articleCreated: boolean
  errorCount: number
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface ContentJobResponse {
  call_id: string
  started_at: string
  status: ContentJobStatus
  slug: string
  response_hash?: string
  error?: string
  article_created?: boolean
}

export interface ContentFinalizerDependencies {
  listCalls(): Promise<Array<{
    id: string
    behavior?: string | null
    session_id?: string | null
    prompt?: string | null
    started_at?: string | null
    response?: string | null
  }>>
  inspectCall(callId: string): Promise<{
    status: string
    response_hash?: string
    error?: string
  }>
  readResponse(callId: string): Promise<string>
  observeProcessFailure(failure: unknown): void
}

export interface ContentFinalizerOptions {
  workerId?: string
  intervalMs?: number
  recoveryIntervalMs?: number
  retryDelayMs?: number
  leaseMs?: number
  maxJobsPerRun?: number
  dependencies?: Partial<ContentFinalizerDependencies>
}

const DEFAULT_INTERVAL_MS = 2_000
const DEFAULT_RECOVERY_INTERVAL_MS = 30_000
const DEFAULT_LEASE_MS = 60_000
const DEFAULT_MAX_JOBS = 100
const MAX_ARTICLE_BYTES = 5 * 1024 * 1024
const RECOVERY_CLOCK_SKEW_MS = 5_000
const WORKER_ID = randomUUID()
const CANONICAL_SLUG_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,119}$/
const LEGACY_CONTENT_FILE_RE = /^content-([0-9a-f]{8})\.md$/

function fromRow(row: ContentJobRow): ContentJob {
  return {
    callId: row.call_id,
    sessionId: row.session_id,
    topic: row.topic,
    startedAt: row.started_at,
    status: row.status,
    slug: row.slug,
    responseHash: row.response_hash,
    error: row.error,
    articleCreated: row.article_created === 1,
    errorCount: row.error_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  }
}

function publicJob(job: ContentJob): ContentJobResponse {
  return {
    call_id: job.callId,
    started_at: job.startedAt,
    status: job.status,
    slug: job.slug,
    ...(job.status === 'completed' ? {
      response_hash: job.responseHash || undefined,
      article_created: job.articleCreated,
    } : {}),
    ...(job.error ? { error: job.error } : {}),
  }
}

export function enqueueContentJob(input: {
  callId: string
  sessionId: string
  topic: string
  startedAt: string
  slug?: string
}): ContentJobResponse {
  const callId = String(input.callId || '').trim()
  const sessionId = String(input.sessionId || '').trim()
  const topic = String(input.topic || '').trim()
  if (!/^[0-9a-fA-F]{32}$/.test(callId)) throw new Error('invalid author-content call id')
  if (!sessionId) throw new Error('session is required')
  if (!topic) throw new Error('topic is required')
  const slug = input.slug || contentSlugForCallId(callId)
  if (!CANONICAL_SLUG_RE.test(slug)) throw new Error('invalid content article slug')
  const now = new Date().toISOString()
  db.prepare(`
    INSERT OR IGNORE INTO content_jobs (
      call_id, session_id, topic, started_at, status, slug,
      next_attempt_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'pending', ?, 0, ?, ?)
  `).run(
    callId,
    sessionId,
    topic,
    String(input.startedAt || now),
    slug,
    now,
    now,
  )
  const job = getContentJob(callId)
  if (!job) throw new Error('failed to persist author-content job')
  return publicJob(job)
}

export function getContentJob(callId: string): ContentJob | null {
  const row = db.prepare('SELECT * FROM content_jobs WHERE call_id = ?').get(callId) as ContentJobRow | undefined
  return row ? fromRow(row) : null
}

export function getContentJobResponse(callId: string): ContentJobResponse | null {
  const job = getContentJob(callId)
  return job ? publicJob(job) : null
}

const claimNextTransaction = db.transaction((
  owner: string,
  now: number,
  leaseMs: number,
  afterCreatedAt: string,
  afterCallId: string,
) => {
  const row = db.prepare(`
    SELECT * FROM content_jobs
    WHERE status IN ('pending', 'running')
      AND next_attempt_at <= ?
      AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
      AND (created_at > ? OR (created_at = ? AND call_id > ?))
    ORDER BY created_at, call_id
    LIMIT 1
  `).get(now, now, afterCreatedAt, afterCreatedAt, afterCallId) as ContentJobRow | undefined
  if (!row) return null

  const updatedAt = new Date(now).toISOString()
  const claimed = db.prepare(`
    UPDATE content_jobs
    SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
    WHERE call_id = ?
      AND status IN ('pending', 'running')
      AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
  `).run(owner, now + leaseMs, updatedAt, row.call_id, now)
  if (claimed.changes !== 1) return null
  return { ...row, lease_owner: owner, lease_expires_at: now + leaseMs, updated_at: updatedAt }
})

function claimNextJob(
  owner: string,
  now: number,
  leaseMs: number,
  afterCreatedAt: string,
  afterCallId: string,
): ContentJobRow | null {
  return claimNextTransaction.immediate(
    owner,
    now,
    leaseMs,
    afterCreatedAt,
    afterCallId,
  ) as ContentJobRow | null
}

function deferOwned(
  callId: string,
  owner: string,
  status: 'pending' | 'running',
  nextAttemptAt: number,
  responseHash: string | null,
): boolean {
  const result = db.prepare(`
    UPDATE content_jobs
    SET status = ?, response_hash = COALESCE(?, response_hash), error = NULL,
        error_count = 0, next_attempt_at = ?, lease_owner = NULL,
        lease_expires_at = NULL, updated_at = ?
    WHERE call_id = ? AND lease_owner = ? AND status IN ('pending', 'running')
  `).run(status, responseHash, nextAttemptAt, new Date().toISOString(), callId, owner)
  return result.changes === 1
}

function failOwned(callId: string, owner: string, error: string, responseHash: string | null = null): boolean {
  const now = new Date().toISOString()
  const result = db.prepare(`
    UPDATE content_jobs
    SET status = 'failed', response_hash = COALESCE(?, response_hash), error = ?,
        lease_owner = NULL, lease_expires_at = NULL, updated_at = ?, completed_at = ?
    WHERE call_id = ? AND lease_owner = ? AND status IN ('pending', 'running')
  `).run(responseHash, error.slice(0, 4_000), now, now, callId, owner)
  return result.changes === 1
}

function recordWorkerError(
  job: ContentJobRow,
  owner: string,
  error: string,
  now: number,
  retryDelayMs: number,
): void {
  const errorCount = job.error_count + 1
  const delay = Math.min(retryDelayMs * (2 ** (errorCount - 1)), 60_000)
  db.prepare(`
    UPDATE content_jobs
    SET error = ?, error_count = ?, next_attempt_at = ?, lease_owner = NULL,
        lease_expires_at = NULL, updated_at = ?
    WHERE call_id = ? AND lease_owner = ? AND status IN ('pending', 'running')
  `).run(error.slice(0, 4_000), errorCount, now + delay, new Date(now).toISOString(), job.call_id, owner)
}

function completeOwned(
  callId: string,
  owner: string,
  responseHash: string,
  articleCreated: boolean,
): boolean {
  const now = new Date().toISOString()
  const result = db.prepare(`
    UPDATE content_jobs
    SET status = 'completed', response_hash = ?, error = NULL,
        article_created = ?, lease_owner = NULL, lease_expires_at = NULL,
        updated_at = ?, completed_at = ?
    WHERE call_id = ? AND lease_owner = ? AND status IN ('pending', 'running')
  `).run(responseHash, articleCreated ? 1 : 0, now, now, callId, owner)
  return result.changes === 1
}

function editorDirectory(): string {
  return process.env.POISE_EDITOR_DIR || join(homedir(), '.poise', 'editor')
}

/**
 * Publish a fully-written article only when the target does not exist.
 * Linking a completed sibling temp file is an atomic create-if-absent on the
 * target filesystem; EEXIST means an earlier worker or the user owns it.
 */
export async function createContentArticleOnce(slug: string, content: string): Promise<boolean> {
  if (!CANONICAL_SLUG_RE.test(slug)) throw new Error('invalid content article slug')
  if (Buffer.byteLength(content, 'utf8') > MAX_ARTICLE_BYTES) {
    throw new Error(`content article too large (max ${MAX_ARTICLE_BYTES} bytes)`)
  }
  const directory = editorDirectory()
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const target = join(directory, `${slug}.md`)
  const temporary = join(directory, `.${slug}.content-job.${process.pid}.${randomUUID()}.tmp`)
  let temporaryExists = false
  try {
    const handle = await open(temporary, 'wx', 0o600)
    temporaryExists = true
    try {
      await handle.writeFile(content, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await link(temporary, target)
    } catch (error: any) {
      if (error?.code === 'EEXIST') {
        const directoryHandle = await open(directory, 'r')
        try { await directoryHandle.sync() } finally { await directoryHandle.close() }
        return false
      }
      throw error
    }
    await unlink(temporary)
    temporaryExists = false
    const directoryHandle = await open(directory, 'r')
    try { await directoryHandle.sync() } finally { await directoryHandle.close() }
    return true
  } finally {
    if (temporaryExists) {
      try { await unlink(temporary) } catch { /* best-effort crash debris cleanup */ }
    }
  }
}

const defaultDependencies: ContentFinalizerDependencies = {
  listCalls: fetchAgentLogs,
  inspectCall: authorContentStatus,
  async readResponse(callId: string): Promise<string> {
    return (await fetchAgentResponse(callId)).body
  },
  observeProcessFailure(failure: unknown): void {
    claudeAuth.observeProcessFailure(failure)
  },
}

interface LegacyContentMapping {
  callId: string
  sessionId: string
  topic: string
  startedAt: string
  slug: string
  responseHash: string | null
}

const persistLegacyContentMappings = db.transaction((
  mappings: LegacyContentMapping[],
  completedAt: string,
) => {
  const alreadyMapped = db.prepare('SELECT 1 FROM meta WHERE key = ?')
    .get(CONTENT_LEGACY_MAPPING_KEY)
  if (alreadyMapped) return 0

  const insert = db.prepare(`
    INSERT OR IGNORE INTO content_jobs (
      call_id, session_id, topic, started_at, status, slug,
      response_hash, article_created, next_attempt_at, error_count,
      created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, 'completed', ?, ?, 1, 0, 0, ?, ?, ?)
  `)
  let inserted = 0
  for (const mapping of mappings) {
    inserted += insert.run(
      mapping.callId,
      mapping.sessionId,
      mapping.topic,
      mapping.startedAt,
      mapping.slug,
      mapping.responseHash,
      completedAt,
      completedAt,
      completedAt,
    ).changes
  }
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?)').run(
    CONTENT_LEGACY_MAPPING_KEY,
    completedAt,
  )
  return inserted
})

/**
 * Upgrade only editor files created by the former short-prefix content path.
 * A file is never created or renamed here: its exact presence plus one unique
 * full author-content call id is the entire authority for the durable mapping.
 */
export async function recoverLegacyContentMappings(
  listCalls: ContentFinalizerDependencies['listCalls'] = defaultDependencies.listCalls,
): Promise<number> {
  return withProcessLock({ path: launchLockPath() }, async () => {
    if (getMeta(CONTENT_LEGACY_MAPPING_KEY) !== null) return 0

    const directory = editorDirectory()
    let names: string[]
    try {
      names = (await readdir(directory)).filter((name) => LEGACY_CONTENT_FILE_RE.test(name))
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error
      names = []
    }

    const completedAt = new Date().toISOString()
    if (names.length === 0) {
      return persistLegacyContentMappings.immediate([], completedAt) as number
    }

    const rowsByCallId = new Map<string, Awaited<ReturnType<typeof listCalls>>>()
    for (const row of await listCalls()) {
      const callId = String(row.id || '').trim()
      if (row.behavior !== 'author_content' || !/^[0-9a-fA-F]{32}$/.test(callId)) continue
      const key = callId.toLowerCase()
      const rows = rowsByCallId.get(key) || []
      rows.push(row)
      rowsByCallId.set(key, rows)
    }

    const mappings: LegacyContentMapping[] = []
    for (const name of names.sort()) {
      const file = await lstat(join(directory, name))
      if (!file.isFile()) continue
      const match = LEGACY_CONTENT_FILE_RE.exec(name)
      if (!match) continue
      const matchingCallIds = [...rowsByCallId.keys()]
        .filter((callId) => callId.startsWith(match[1]))
      if (matchingCallIds.length !== 1) continue

      const attributableRows = (rowsByCallId.get(matchingCallIds[0]) || []).filter((row) =>
        String(row.session_id || '').trim()
        && String(row.prompt || '').trim()
        && Number.isFinite(Date.parse(String(row.started_at || ''))),
      )
      const identities = new Map<string, typeof attributableRows[number]>()
      for (const row of attributableRows) {
        identities.set(JSON.stringify([
          String(row.session_id),
          String(row.prompt),
          String(row.started_at),
        ]), row)
      }
      if (identities.size !== 1) continue
      const row = identities.values().next().value
      if (!row) continue
      const responseHash = String(row.response || '').trim()
      mappings.push({
        callId: String(row.id),
        sessionId: String(row.session_id),
        topic: String(row.prompt),
        startedAt: String(row.started_at),
        slug: name.slice(0, -3),
        responseHash: responseHash || null,
      })
    }

    return persistLegacyContentMappings.immediate(mappings, completedAt) as number
  })
}

async function reconcileClaimedJob(
  job: ContentJobRow,
  owner: string,
  now: number,
  retryDelayMs: number,
  dependencies: ContentFinalizerDependencies,
): Promise<void> {
  try {
    const observed = await dependencies.inspectCall(job.call_id)
    const status = String(observed.status || '').toLowerCase()
    const responseHash = observed.response_hash ? String(observed.response_hash) : null

    if (status === 'completed') {
      if (!responseHash) {
        throw new Error('author-content completed without a response')
      }
      // agent-interface log rows expose only an eight-character response
      // prefix, while the full call id is the unambiguous read key.
      const body = await dependencies.readResponse(job.call_id)
      const created = await createContentArticleOnce(job.slug, String(body || ''))
      completeOwned(job.call_id, owner, responseHash, created)
      return
    }

    if (['failed', 'error', 'cancelled', 'canceled', 'timed_out', 'timeout'].includes(status)) {
      const message = observed.error || `author-content ended with status ${status}`
      dependencies.observeProcessFailure({ code: 1, signal: null, error: new Error(message) })
      failOwned(job.call_id, owner, message, responseHash)
      return
    }

    const durableStatus: 'pending' | 'running' = ['running', 'in_progress'].includes(status)
      ? 'running'
      : 'pending'
    deferOwned(job.call_id, owner, durableStatus, now + retryDelayMs, responseHash)
  } catch (error) {
    recordWorkerError(
      job,
      owner,
      error instanceof Error ? error.message : String(error),
      now,
      retryDelayMs,
    )
  }
}

function resolvedDependencies(
  dependencies: Partial<ContentFinalizerDependencies> | undefined,
): ContentFinalizerDependencies {
  return { ...defaultDependencies, ...dependencies }
}

export async function runContentFinalizerOnce(options: ContentFinalizerOptions = {}): Promise<number> {
  if (!db.open) return 0
  const owner = options.workerId || WORKER_ID
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_INTERVAL_MS
  const maxJobs = options.maxJobsPerRun ?? DEFAULT_MAX_JOBS
  const dependencies = resolvedDependencies(options.dependencies)
  let processed = 0
  let afterCreatedAt = ''
  let afterCallId = ''
  while (processed < maxJobs) {
    const now = Date.now()
    const job = claimNextJob(owner, now, leaseMs, afterCreatedAt, afterCallId)
    if (!job) break
    afterCreatedAt = job.created_at
    afterCallId = job.call_id
    processed += 1
    await reconcileClaimedJob(job, owner, now, retryDelayMs, dependencies)
  }
  return processed
}

let runtimeTimer: NodeJS.Timeout | null = null
let runtimeRun: Promise<void> | null = null
let runtimeStopped = true
let runtimeOptions: ContentFinalizerOptions = {}
let runtimeNextRecoveryAt = 0

function launchLockPath(): string {
  const configuredDb = process.env.POISE_DB
  const directory = configuredDb && configuredDb !== ':memory:'
    ? dirname(resolve(configuredDb))
    : join(homedir(), '.poise')
  return join(directory, '.poise-content-launch-lock.sqlite3')
}

const REGISTRATION_DEADLINE_ERROR = 'author-content registration deadline expired'

function expirePendingLaunches(now: number, sessionId?: string): number {
  const updatedAt = new Date(now).toISOString()
  const result = sessionId
    ? db.prepare(`
        UPDATE content_launches
        SET status = 'failed', error = ?, updated_at = ?
        WHERE status = 'pending'
          AND registration_deadline_at <= ?
          AND session_id = ?
      `).run(REGISTRATION_DEADLINE_ERROR, updatedAt, now, sessionId)
    : db.prepare(`
        UPDATE content_launches
        SET status = 'failed', error = ?, updated_at = ?
        WHERE status = 'pending'
          AND registration_deadline_at <= ?
      `).run(REGISTRATION_DEADLINE_ERROR, updatedAt, now)
  return result.changes
}

function persistLaunchIntent(sessionId: string, topic: string): ContentLaunchRow {
  const nowMs = Date.now()
  // A periodic worker is not required for retry safety. The next launch also
  // terminalizes an expired predecessor before enforcing one pending session.
  expirePendingLaunches(nowMs, sessionId)
  const existing = db.prepare(`
    SELECT * FROM content_launches
    WHERE session_id = ? AND status = 'pending'
    LIMIT 1
  `).get(sessionId) as ContentLaunchRow | undefined
  if (existing) throw new ContentLaunchPendingError(sessionId)

  const launchId = randomUUID()
  const now = new Date(nowMs).toISOString()
  try {
    db.prepare(`
      INSERT INTO content_launches (
        launch_id, session_id, topic, requested_at,
        registration_deadline_at, recovery_eligible, status, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, 'pending', ?)
    `).run(
      launchId,
      sessionId,
      topic,
      now,
      nowMs + CONTENT_LAUNCH_REGISTRATION_TIMEOUT_MS,
      now,
    )
  } catch (error: any) {
    const pending = db.prepare(`
      SELECT 1 FROM content_launches
      WHERE session_id = ? AND status = 'pending'
    `).get(sessionId)
    if (String(error?.code || '').startsWith('SQLITE_CONSTRAINT') && pending) {
      throw new ContentLaunchPendingError(sessionId)
    }
    throw error
  }
  return db.prepare('SELECT * FROM content_launches WHERE launch_id = ?')
    .get(launchId) as ContentLaunchRow
}

function markLaunchAttempted(launchId: string): void {
  const updated = db.prepare(`
    UPDATE content_launches
    SET recovery_eligible = 1, updated_at = ?
    WHERE launch_id = ? AND status = 'pending'
  `).run(new Date().toISOString(), launchId)
  if (updated.changes !== 1) throw new Error('author-content launch intent is no longer pending')
}

function updatePendingLaunchError(launchId: string, error: string): void {
  db.prepare(`
    UPDATE content_launches
    SET error = ?, updated_at = ?
    WHERE launch_id = ? AND status = 'pending'
  `).run(error.slice(0, 4_000), new Date().toISOString(), launchId)
}

function failPendingLaunch(launchId: string, error: string): void {
  db.prepare(`
    UPDATE content_launches
    SET status = 'failed', recovery_eligible = 0, error = ?, updated_at = ?
    WHERE launch_id = ? AND status = 'pending'
  `).run(error.slice(0, 4_000), new Date().toISOString(), launchId)
}

function invalidateLaunchRecovery(launchId: string, error: string): void {
  db.prepare(`
    UPDATE content_launches
    SET status = 'failed', recovery_eligible = 0, error = ?, updated_at = ?
    WHERE launch_id = ? AND call_id IS NULL
  `).run(error.slice(0, 4_000), new Date().toISOString(), launchId)
}

function recordLaunchRecoveryState(
  intent: ContentLaunchRow,
  error: string,
  now: number,
): void {
  if (intent.status === 'pending' && now >= intent.registration_deadline_at) {
    db.prepare(`
      UPDATE content_launches
      SET status = 'failed', error = ?, updated_at = ?
      WHERE launch_id = ? AND status = 'pending'
    `).run(error.slice(0, 4_000), new Date(now).toISOString(), intent.launch_id)
    return
  }
  db.prepare(`
    UPDATE content_launches
    SET error = ?, updated_at = ?
    WHERE launch_id = ?
      AND call_id IS NULL
      AND (status = 'pending' OR (status = 'failed' AND recovery_eligible = 1))
  `).run(error.slice(0, 4_000), new Date(now).toISOString(), intent.launch_id)
}

const linkLaunchTransaction = db.transaction((
  launchId: string,
  callId: string,
  sessionId: string,
  topic: string,
  startedAt: string,
) => {
  const launch = db.prepare(`
    SELECT status, recovery_eligible, call_id
    FROM content_launches WHERE launch_id = ?
  `).get(launchId) as {
    status: string
    recovery_eligible: number
    call_id: string | null
  } | undefined
  const linkable = launch?.status === 'pending'
    || (launch?.status === 'failed'
      && launch.recovery_eligible === 1
      && launch.call_id === null)
  if (!linkable) {
    throw new Error('author-content launch intent is no longer recoverable')
  }
  const job = enqueueContentJob({ callId, sessionId, topic, startedAt })
  const linked = db.prepare(`
    UPDATE content_launches
    SET status = 'linked', call_id = ?, recovery_eligible = 0,
        error = NULL, updated_at = ?
    WHERE launch_id = ?
      AND call_id IS NULL
      AND (status = 'pending' OR (status = 'failed' AND recovery_eligible = 1))
  `).run(callId, new Date().toISOString(), launchId)
  if (linked.changes !== 1) throw new Error('failed to link author-content launch intent')
  return job
})

function linkLaunchIntent(
  launchId: string,
  callId: string,
  sessionId: string,
  topic: string,
  startedAt: string,
): ContentJobResponse {
  return linkLaunchTransaction.immediate(
    launchId,
    callId,
    sessionId,
    topic,
    startedAt,
  ) as ContentJobResponse
}

export async function launchAndEnqueueContentJob(
  topic: string,
  sessionId: string,
  launch: typeof startAuthorContent = startAuthorContent,
): Promise<ContentJobResponse> {
  const normalizedTopic = normalizeAuthorContentTopic(topic)
  const normalizedSessionId = String(sessionId || '').trim()
  if (!normalizedSessionId) throw new HttpError(400, 'session is required')
  // Tests and recovery tools can inject a non-agent launcher. Production's
  // default path and the launcher itself are both guarded.
  if (launch === startAuthorContent) await claudeAuth.requireReady()

  return withProcessLock({ path: launchLockPath() }, async () => {
    // Commit intent before spawn so a crash anywhere after this point is
    // recoverable without attributing unrelated global log rows.
    const intent = persistLaunchIntent(normalizedSessionId, normalizedTopic)
    let launched: Awaited<ReturnType<typeof startAuthorContent>>
    try {
      markLaunchAttempted(intent.launch_id)
      launched = await launch(normalizedTopic, normalizedSessionId)
    } catch (error: any) {
      const message = error?.message || String(error)
      if (isAuthorContentDiscoveryPendingError(error)) {
        updatePendingLaunchError(intent.launch_id, message)
        wakeContentFinalizer()
      } else {
        failPendingLaunch(intent.launch_id, message)
      }
      throw error
    }

    try {
      const job = linkLaunchIntent(
        intent.launch_id,
        String(launched.call_id || ''),
        normalizedSessionId,
        normalizedTopic,
        String(launched.started_at || ''),
      )
      wakeContentFinalizer()
      return job
    } catch (error: any) {
      // The child may already exist. Keep the intent pending so periodic
      // exact-match recovery can finish the durable link.
      updatePendingLaunchError(intent.launch_id, error?.message || String(error))
      wakeContentFinalizer()
      throw error
    }
  })
}

export async function recoverPendingContentLaunches(
  listCalls: ContentFinalizerDependencies['listCalls'] = defaultDependencies.listCalls,
): Promise<number> {
  const recovered = await withProcessLock({ path: launchLockPath() }, async () => {
    const intents = db.prepare(`
      SELECT * FROM content_launches
      WHERE status = 'pending'
         OR (status = 'failed' AND recovery_eligible = 1 AND call_id IS NULL)
      ORDER BY requested_at, launch_id
    `).all() as ContentLaunchRow[]
    // A Poise launch intent is mandatory. Never enumerate global history and
    // fabricate jobs or sessions for calls Poise did not launch.
    if (intents.length === 0) return 0

    const watermarkMs = Date.parse(String(getMeta(CONTENT_LAUNCH_RECOVERY_WATERMARK_KEY) || ''))
    if (!Number.isFinite(watermarkMs)) {
      throw new Error('content launch recovery watermark is missing or invalid')
    }
    const now = Date.now()
    const boundedIntents: Array<{
      intent: ContentLaunchRow
      lowerBoundMs: number
      upperBoundMs: number
    }> = []
    for (const intent of intents) {
      const requestedAtMs = Date.parse(intent.requested_at)
      const deadlineAtMs = Number(intent.registration_deadline_at)
      if (!Number.isFinite(requestedAtMs)
        || !Number.isSafeInteger(deadlineAtMs)
        || deadlineAtMs <= 0
        || deadlineAtMs < requestedAtMs) {
        invalidateLaunchRecovery(
          intent.launch_id,
          'launch intent has an invalid registration time window',
        )
        continue
      }
      boundedIntents.push({
        intent,
        lowerBoundMs: Math.max(requestedAtMs - RECOVERY_CLOCK_SKEW_MS, watermarkMs),
        upperBoundMs: deadlineAtMs + RECOVERY_CLOCK_SKEW_MS,
      })
    }
    if (boundedIntents.length === 0) return 0

    const rows = await listCalls()
    const linkedCallIds = new Set((db.prepare(`
      SELECT call_id FROM content_launches WHERE call_id IS NOT NULL
    `).all() as Array<{ call_id: string }>).map((row) => row.call_id.toLowerCase()))

    type ListedCall = Awaited<ReturnType<ContentFinalizerDependencies['listCalls']>>[number]
    interface RecoveryCall {
      callId: string
      startedAtMs: number
      row: ListedCall
    }
    const groupedRows = new Map<string, ListedCall[]>()
    for (const row of rows) {
      const callId = String(row.id || '').trim()
      if (row.behavior !== 'author_content'
        || !/^[0-9a-fA-F]{32}$/.test(callId)
        || linkedCallIds.has(callId.toLowerCase())) continue
      const key = callId.toLowerCase()
      const group = groupedRows.get(key) || []
      group.push(row)
      groupedRows.set(key, group)
    }

    const calls: RecoveryCall[] = []
    for (const group of groupedRows.values()) {
      const identities = new Set(group.map((row) => JSON.stringify([
        String(row.session_id || ''),
        String(row.prompt || '').trim(),
        String(row.started_at || ''),
      ])))
      // Conflicting duplicate records for one full id are not attributable.
      if (identities.size !== 1) continue
      const row = group[0]
      const startedAtMs = Date.parse(String(row.started_at || ''))
      if (!Number.isFinite(startedAtMs)) continue
      calls.push({ callId: String(row.id).trim(), startedAtMs, row })
    }

    const matchesByIntent = new Map<string, RecoveryCall[]>()
    const matchesByCall = new Map<string, typeof boundedIntents>()
    for (const candidate of calls) {
      const matchingIntents = boundedIntents.filter(({ intent, lowerBoundMs, upperBoundMs }) =>
        String(candidate.row.session_id || '') === intent.session_id
        && String(candidate.row.prompt || '').trim() === intent.topic
        && candidate.startedAtMs >= lowerBoundMs
        && candidate.startedAtMs <= upperBoundMs,
      )
      if (matchingIntents.length === 0) continue
      matchesByCall.set(candidate.callId.toLowerCase(), matchingIntents)
      for (const { intent } of matchingIntents) {
        const matches = matchesByIntent.get(intent.launch_id) || []
        matches.push(candidate)
        matchesByIntent.set(intent.launch_id, matches)
      }
    }

    let inserted = 0
    for (const { intent } of boundedIntents) {
      const candidates = matchesByIntent.get(intent.launch_id) || []
      if (candidates.length === 0) {
        if (intent.status === 'pending') {
          recordLaunchRecoveryState(
            intent,
            now >= intent.registration_deadline_at
              ? REGISTRATION_DEADLINE_ERROR
              : 'awaiting attributable author-content log row',
            now,
          )
        }
        continue
      }
      if (candidates.length > 1) {
        const ambiguity = `ambiguous recovery: ${candidates.length} matching author-content log rows`
        recordLaunchRecoveryState(
          intent,
          intent.status === 'pending' && now >= intent.registration_deadline_at
            ? `${ambiguity}; ${REGISTRATION_DEADLINE_ERROR}`
            : ambiguity,
          now,
        )
        continue
      }

      const candidate = candidates[0]
      if ((matchesByCall.get(candidate.callId.toLowerCase()) || []).length !== 1) {
        const ambiguity = 'ambiguous recovery: call matches multiple launch intent windows'
        recordLaunchRecoveryState(
          intent,
          intent.status === 'pending' && now >= intent.registration_deadline_at
            ? `${ambiguity}; ${REGISTRATION_DEADLINE_ERROR}`
            : ambiguity,
          now,
        )
        continue
      }
      linkLaunchIntent(
        intent.launch_id,
        candidate.callId,
        intent.session_id,
        intent.topic,
        String(candidate.row.started_at),
      )
      linkedCallIds.add(candidate.callId.toLowerCase())
      inserted += 1
    }
    return inserted
  })
  if (recovered > 0) wakeContentFinalizer()
  return recovered
}

function scheduleRuntime(delayMs: number): void {
  if (runtimeStopped || runtimeTimer || runtimeRun) return
  runtimeTimer = setTimeout(() => {
    runtimeTimer = null
    if (runtimeStopped || !db.open) {
      runtimeStopped = true
      return
    }
    const dependencies = resolvedDependencies(runtimeOptions.dependencies)
    runtimeRun = (async () => {
      const now = Date.now()
      if (now >= runtimeNextRecoveryAt) {
        await recoverLegacyContentMappings(dependencies.listCalls)
        await recoverPendingContentLaunches(dependencies.listCalls)
        runtimeNextRecoveryAt = now
          + (runtimeOptions.recoveryIntervalMs ?? DEFAULT_RECOVERY_INTERVAL_MS)
      }
      await runContentFinalizerOnce({ ...runtimeOptions, dependencies })
    })()
      .catch((error: unknown) => {
        console.error('[content-jobs] reconciliation failed:', error)
      })
      .finally(() => {
        runtimeRun = null
        scheduleRuntime(runtimeOptions.intervalMs ?? DEFAULT_INTERVAL_MS)
      })
  }, Math.max(0, delayMs))
  runtimeTimer.unref()
}

export function startContentFinalizer(options: ContentFinalizerOptions = {}): void {
  if (!runtimeStopped) return
  runtimeStopped = false
  runtimeOptions = options
  runtimeNextRecoveryAt = 0
  scheduleRuntime(0)
}

export function wakeContentFinalizer(): void {
  if (runtimeStopped || runtimeRun) return
  if (runtimeTimer) clearTimeout(runtimeTimer)
  runtimeTimer = null
  scheduleRuntime(0)
}

export async function stopContentFinalizer(): Promise<void> {
  runtimeStopped = true
  if (runtimeTimer) clearTimeout(runtimeTimer)
  runtimeTimer = null
  if (runtimeRun) await runtimeRun
}
