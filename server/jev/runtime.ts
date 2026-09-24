import { createHash } from 'node:crypto'
import { db } from '../db'
import { HttpError } from '../http'
import { readMemories } from '../chat/memories'
import { releaseBackgroundPaused, trackReleaseBackground } from '../release-background'
import { parseJevDraft } from '../../src/jev-draft'
import { JEV_REQUEST_BYTES, validateJevRequest, type JevSession, type JevRun, type JevRequest } from '../../src/jev-types'
import { evaluateJev, listJevModels } from './provider'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const now = () => new Date().toISOString()
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const liveRuns = new Set<string>()
function id(value: unknown): asserts value is string { if (typeof value !== 'string' || !UUID.test(value)) throw new HttpError(400, 'A valid workspace/run ID is required.') }
function draft(value: unknown): asserts value is string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 2 * JEV_REQUEST_BYTES) throw new HttpError(400, 'The builder draft must fit within 2 MiB.')
  parseJevDraft(value)
}
interface Options { fetch?: typeof fetch; key?: () => string | undefined; memories?: () => string; timeoutMs?: number }
interface Row { body: string }
/** Stateless typed evaluations, separate from native agents, tools and checkouts. */
export class JevRuntime {
  private jobs = new Map<string, { abort: AbortController; task: Promise<void> }>()
  private unsaved = new Map<string, JevRun>()
  private stopped = false
  private modelCache?: { at: number; value: Awaited<ReturnType<typeof listJevModels>> }
  private modelRequest?: ReturnType<typeof listJevModels>
  constructor(private options: Options = {}) {
    db.exec(`CREATE TABLE IF NOT EXISTS jev_sessions (id TEXT PRIMARY KEY, body TEXT NOT NULL, creation TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jev_runs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES jev_sessions(id) ON DELETE CASCADE, fingerprint TEXT NOT NULL, status TEXT NOT NULL, owner INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS jev_runs_session ON jev_runs(session_id);
      CREATE UNIQUE INDEX IF NOT EXISTS jev_running_session ON jev_runs(session_id) WHERE status = 'running';`)
    for (const row of db.prepare("SELECT body, owner FROM jev_runs WHERE status = 'running'").all() as (Row & { owner: number })[]) {
      const run = JSON.parse(row.body) as JevRun
      let alive = true
      try { process.kill(row.owner, 0) } catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH' }
      if (!alive || (row.owner === process.pid && !liveRuns.has(run.id))) this.finish({ ...run, status: 'interrupted', error: 'Poise stopped before the result was recorded. This evaluation was not replayed; it may have been billed.' })
    }
  }
  configured(): boolean { return !!this.key() }
  private key(): string | undefined { return (this.options.key ?? (() => process.env.JEV_API_KEY))()?.trim() }
  async models() {
    const key = this.key()
    if (!key) throw new HttpError(503, 'JEV_API_KEY is not configured on the server.')
    if (this.modelCache && Date.now() - this.modelCache.at < 60_000) return this.modelCache.value
    this.modelRequest ??= listJevModels(key, this.options.fetch).then(value => { this.modelCache = { at: Date.now(), value }; return value }).finally(() => { this.modelRequest = undefined })
    return this.modelRequest
  }
  list(): JevSession[] { return (db.prepare('SELECT body FROM jev_sessions ORDER BY rowid DESC').all() as Row[]).map(row => JSON.parse(row.body)) }
  get(sessionId: string): JevSession {
    id(sessionId)
    const row = db.prepare('SELECT body FROM jev_sessions WHERE id=?').get(sessionId) as Row | undefined
    if (!row) throw new HttpError(404, 'JEV workspace not found.')
    return JSON.parse(row.body)
  }
  create(input: { id: string; title?: string; draft: string }): JevSession {
    if (!input) throw new HttpError(400, 'A workspace is required.')
    id(input.id); draft(input.draft)
    const title = String(input.title || 'Untitled primitives').trim().slice(0, 200) || 'Untitled primitives'
    return db.transaction(() => {
      const prior = db.prepare('SELECT creation FROM jev_sessions WHERE id=?').get(input.id) as { creation: string } | undefined
      const creation = fingerprint({ title, draft: input.draft })
      if (prior && prior.creation !== creation) throw new HttpError(409, 'This workspace ID belongs to a different builder. Your draft was not overwritten.')
      if (!prior) {
        const session: JevSession = { id: input.id, title, draft: input.draft, revision: 1, createdAt: now(), updatedAt: now() }
        db.prepare('INSERT INTO jev_sessions(id,body,creation) VALUES(?,?,?)').run(input.id, JSON.stringify(session), creation)
      }
      return this.get(input.id)
    }).immediate()
  }
  update(sessionId: string, input: { revision: number; title: string; draft: string }): JevSession {
    if (!input) throw new HttpError(400, 'A workspace update is required.')
    draft(input.draft)
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200) throw new HttpError(400, 'Workspace title must contain 1–200 characters.')
    return db.transaction(() => {
      const current = this.get(sessionId)
      if (current.draft === input.draft && current.title === input.title) return current
      if (current.revision !== input.revision) throw new HttpError(409, 'This workspace changed in another tab. Your draft is kept. Reload the saved version or explicitly save your version.')
      const next = { ...current, title: input.title, draft: input.draft, revision: current.revision + 1, updatedAt: now() }
      db.prepare('UPDATE jev_sessions SET body=? WHERE id=?').run(JSON.stringify(next), sessionId)
      return next
    }).immediate()
  }
  remove(sessionId: string): void {
    db.transaction(() => {
      this.get(sessionId)
      if (db.prepare("SELECT id FROM jev_runs WHERE session_id=? AND status='running'").get(sessionId)) throw new HttpError(409, 'Stop the evaluation before deleting this workspace.')
      db.prepare('DELETE FROM jev_sessions WHERE id=?').run(sessionId)
    }).immediate()
  }
  runs(sessionId: string, before?: number): { runs: JevRun[]; next?: number } {
    this.get(sessionId); this.flushResults()
    const rows = db.prepare('SELECT rowid AS seq, body FROM jev_runs WHERE session_id=? AND rowid<? ORDER BY rowid DESC LIMIT 21').all(sessionId, before || Number.MAX_SAFE_INTEGER) as (Row & { seq: number })[]
    return { runs: rows.slice(0, 20).map(row => { const run = JSON.parse(row.body) as JevRun; return this.unsaved.get(run.id) || run }), ...(rows.length > 20 ? { next: rows[19].seq } : {}) }
  }
  run(runId: string): JevRun {
    id(runId); this.flushResults()
    if (this.unsaved.has(runId)) return structuredClone(this.unsaved.get(runId)!)
    const row = db.prepare('SELECT body FROM jev_runs WHERE id=?').get(runId) as Row | undefined
    if (!row) throw new HttpError(404, 'Evaluation not found.')
    return JSON.parse(row.body)
  }
  effective(input: unknown): JevRequest {
    const request = structuredClone(validateJevRequest(input))
    const memories = (this.options.memories ?? (() => readMemories().text))()
    if (memories) for (const question of Object.values(request.questions)) {
      question.instructions = typeof question.instructions === 'string' ? `${question.instructions}\n\n[Memories]\n${memories}` : [question.instructions, { Memories: memories }]
    }
    return validateJevRequest(request)
  }
  start(sessionId: string, runId: string, input: unknown): JevRun {
    this.get(sessionId); id(runId); this.flushResults()
    const request = validateJevRequest(input), digest = fingerprint({ sessionId, request })
    const prior = db.prepare('SELECT fingerprint,body FROM jev_runs WHERE id=?').get(runId) as (Row & { fingerprint: string }) | undefined
    if (prior) { if (prior.fingerprint !== digest) throw new HttpError(409, 'This evaluation ID belongs to a different request.'); return this.run(runId) }
    if (this.stopped || releaseBackgroundPaused()) throw new HttpError(503, 'Poise is updating; the evaluation has not started.')
    const key = this.key()
    if (!key) throw new HttpError(503, 'JEV_API_KEY is not configured on the Poise server.')
    const run: JevRun = { id: runId, sessionId, status: 'running', input: structuredClone(request), request: this.effective(request), startedAt: now() }
    db.transaction(() => {
      if (db.prepare("SELECT id FROM jev_runs WHERE session_id=? AND status='running'").get(sessionId)) throw new HttpError(409, 'This workspace already has an evaluation running.')
      db.prepare('INSERT INTO jev_runs(id,session_id,fingerprint,status,owner,body) VALUES(?,?,?,?,?,?)').run(runId, sessionId, digest, run.status, process.pid, JSON.stringify(run))
    }).immediate()
    const abort = new AbortController(), finished = trackReleaseBackground()
    liveRuns.add(runId)
    const task = this.execute(run, key, abort.signal).finally(() => { this.jobs.delete(runId); liveRuns.delete(runId); finished() })
    this.jobs.set(runId, { abort, task })
    void task.catch(() => undefined)
    return structuredClone(run)
  }
  private finish(run: JevRun): void {
    run.finishedAt ??= now(); run.durationMs ??= Date.parse(run.finishedAt) - Date.parse(run.startedAt)
    try {
      const saved = { ...run }; delete saved.storageWarning
      db.prepare('UPDATE jev_runs SET status=?,body=? WHERE id=?').run(saved.status, JSON.stringify(saved), saved.id)
      this.unsaved.delete(run.id)
    } catch {
      run.storageWarning = 'This result could not be saved to disk. Copy the JSON now; Poise will retry saving it, never the evaluation.'
      this.unsaved.set(run.id, structuredClone(run))
    }
  }
  private flushResults(): void { for (const run of [...this.unsaved.values()]) this.finish(run) }
  private async execute(run: JevRun, key: string, cancelled: AbortSignal): Promise<void> {
    const deadline = new AbortController(), stop = () => deadline.abort()
    cancelled.addEventListener('abort', stop, { once: true })
    if (cancelled.aborted) stop()
    const timeout = this.options.timeoutMs ?? 60_000
    const timer = setTimeout(stop, timeout)
    try {
      run.result = await evaluateJev(run.request, key, deadline.signal, this.options.fetch)
      run.status = 'completed'
    } catch (error) {
      run.status = cancelled.aborted ? 'cancelled' : 'error'
      run.error = cancelled.aborted ? 'Stopped locally. JEV may already have processed or billed this request; it was not retried.'
        : deadline.signal.aborted ? `JEV timed out after ${timeout / 1000} seconds. The outcome is uncertain; this request was not retried.`
        : error instanceof TypeError ? 'Could not reach JEV. Check the connection and try again.' : (error as Error).message
      if (key && run.error) run.error = run.error.split(key).join('[redacted]')
    } finally { clearTimeout(timer); cancelled.removeEventListener('abort', stop) }
    this.finish(run)
  }
  async cancel(runId: string): Promise<JevRun> {
    const run = this.run(runId), job = this.jobs.get(runId)
    if (run.status === 'running' && !job) throw new HttpError(409, 'This evaluation belongs to another process. It will not be replayed.')
    job?.abort.abort(); await job?.task
    return this.run(runId)
  }
  async stop(): Promise<void> {
    this.stopped = true
    for (const job of this.jobs.values()) job.abort.abort()
    await Promise.allSettled([...this.jobs.values()].map(job => job.task))
    this.flushResults()
  }
}
