import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { validateJevRequest, validateJevResult, type JevRequest } from '../src/jev-types'
import { draftFromRequest, requestFromDraft, exampleJevDraft } from '../src/jev-draft'
let root: string, database: typeof import('../server/db'), Runtime: typeof import('../server/jev/runtime').JevRuntime
const engines: import('../server/jev/runtime').JevRuntime[] = []
const request: JevRequest = { model: 'jev-latest', state: 'Please refund the duplicate charge.', questions: { refund: { type: 'noul', instructions: 'Is a refund requested?' } } }
const answer = { model: 'jev-1.13.0', answers: { refund: { type: 'noul', noul: .95 } }, usage: { input_tokens: 10, output_tokens: 3 } }
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-jev-'))
  vi.stubEnv('POISE_DB', join(root, 'test.sqlite3'))
  database = await import('../server/db'); Runtime = (await import('../server/jev/runtime')).JevRuntime
})
beforeEach(() => { const engine = new Runtime({ key: () => 'fixture-key' }); engines.push(engine); database.db.exec('DELETE FROM jev_runs; DELETE FROM jev_sessions;') })
afterEach(async () => { await Promise.all(engines.splice(0).map(e => e.stop())) })
afterAll(async () => { database.closeDatabase(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })
function setup(fetcher: typeof fetch = vi.fn(async () => Response.json(answer)), memories = '') {
  const engine = new Runtime({ key: () => 'fixture-key', fetch: fetcher, memories: () => memories, timeoutMs: 1000 }); engines.push(engine)
  const session = engine.create({ id: randomUUID(), draft: JSON.stringify(exampleJevDraft()) })
  return { engine, session, fetcher }
}
async function complete(engine: import('../server/jev/runtime').JevRuntime, id: string) {
  await vi.waitFor(() => expect(engine.run(id).status).not.toBe('running'))
  return engine.run(id)
}
describe('JEV primitives', () => {
  it('round-trips all types and structured instructions/criteria without narrowing them', () => {
    const value: JevRequest = { model: 'jev-preview', state: { ticket: ['context', { amount: 42 }] }, questions: {
      route: { type: 'choice', instructions: { question: 'Which category?', examples: ['a'] }, criteria: { a: null, b: { includes: ['b'] } } },
      strength: { type: 'score', instructions: ['Rate it', { guide: 'be precise' }], criteria: ['low', { description: 'high' }] },
      yes: { type: 'noul', instructions: 'Does it apply?', criteria: { true: { evidence: ['x'] }, false: ['No evidence'] } },
    } }
    expect(requestFromDraft(draftFromRequest(value))).toEqual(value)
    expect(validateJevRequest(value)).toBe(value)
  })
  it('validates limits, repeated form IDs, malformed criteria and non-JSON values', () => {
    const draft = exampleJevDraft(); draft.questions[1].id = draft.questions[0].id
    expect(() => requestFromDraft(draft)).toThrow(/repeated/)
    for (const question of [{ type: 'score', instructions: 'Rate', criteria: ['only'] }, { type: 'choice', instructions: 'Choose', criteria: { only: null } }, { type: 'chat', instructions: 'Speak' }]) expect(() => validateJevRequest({ ...request, questions: { x: question } })).toThrow()
    expect(() => validateJevRequest({ ...request, stream: true })).toThrow(/unknown field/)
    expect(() => validateJevRequest({ ...request, state: { number: NaN } })).toThrow(/finite/)
    expect(() => validateJevRequest({ ...request, state: 'x'.repeat(1024 * 1024) })).toThrow(/1 MiB/)
  })
  it('requires typed answers and exact IDs, bounds probabilities and distinguishes confidence', () => {
    expect(validateJevResult(answer, request)).toEqual(answer)
    for (const value of [{ ...answer, answers: {} }, { ...answer, answers: { refund: { type: 'noul', noul: 2 } } }, { ...answer, answers: { refund: { type: 'choice', choice: 'yes' } } }]) expect(() => validateJevResult(value, request)).toThrow()
  })
  it('sends only the explicit state/questions, with Memories last, and a server-only credential', async () => {
    const w = setup(undefined, 'Be precise.')
    const started = w.engine.start(w.session.id, randomUUID(), request)
    expect((await complete(w.engine, started.id)).result).toEqual(answer)
    const [url, options] = vi.mocked(w.fetcher).mock.calls[0]
    expect(url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(options?.headers).toMatchObject({ Authorization: 'Bearer fixture-key' })
    expect(JSON.parse(String(options?.body))).toEqual({ ...request, questions: { refund: { type: 'noul', instructions: 'Is a refund requested?\n\n[Memories]\nBe precise.' } } })
    expect(JSON.stringify(w.engine.run(started.id))).not.toContain('fixture-key')
    expect(w.engine.run(started.id).input).toEqual(request)
  })
  it('deduplicates retries, rejects mismatched identities and never auto-repeats a failed evaluation', async () => {
    const w = setup(vi.fn(async () => new Response('private upstream diagnostic', { status: 429 })))
    const runId = randomUUID()
    w.engine.start(w.session.id, runId, request)
    await complete(w.engine, runId)
    expect(w.engine.start(w.session.id, runId, request).status).toBe('error')
    expect(w.fetcher).toHaveBeenCalledTimes(1)
    expect(w.engine.run(runId).error).not.toContain('private upstream')
    expect(() => w.engine.start(w.session.id, runId, { ...request, state: 'different' })).toThrow(/different request/)
  })
  it('cancels a running evaluation and preserves its inputs and the editable draft', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, options) => new Promise((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))))
    const w = setup(fetcher), run = w.engine.start(w.session.id, randomUUID(), request)
    expect(() => w.engine.start(w.session.id, randomUUID(), request)).toThrow(/already/)
    expect(() => w.engine.remove(w.session.id)).toThrow(/Stop/)
    expect((await w.engine.cancel(run.id)).status).toBe('cancelled')
    expect(w.engine.get(w.session.id).draft).toBe(w.session.draft)
    expect(w.engine.run(run.id).request.state).toBe(request.state)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('preserves newer workspace edits against a stale tab and retains completed runs on reopen', async () => {
    const w = setup(), run = w.engine.start(w.session.id, randomUUID(), request)
    await complete(w.engine, run.id)
    const updated = w.engine.update(w.session.id, { revision: 1, title: 'My primitives', draft: w.session.draft })
    expect(updated.revision).toBe(2)
    expect(() => w.engine.update(w.session.id, { revision: 1, title: 'Stale name', draft: w.session.draft })).toThrow(/another tab/)
    const other = new Runtime({ key: () => undefined }); engines.push(other)
    expect(other.run(run.id).result).toEqual(answer)
    expect(other.get(w.session.id).title).toBe('My primitives')
  })
  it('rejects a missing key or invalid primitive before any external request', () => {
    const fetcher = vi.fn<typeof fetch>()
    const engine = new Runtime({ key: () => undefined, fetch: fetcher }); engines.push(engine)
    const session = engine.create({ id: randomUUID(), draft: JSON.stringify(exampleJevDraft()) })
    expect(() => engine.start(session.id, randomUUID(), request)).toThrow(/JEV_API_KEY/)
    expect(() => engine.start(session.id, randomUUID(), { state: 'x' })).toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('settles a deadline without retrying or leaving the evaluation running', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, options) => new Promise((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))))
    const engine = new Runtime({ key: () => 'fixture', fetch: fetcher, timeoutMs: 20, memories: () => '' }); engines.push(engine)
    const session = engine.create({ id: randomUUID(), draft: JSON.stringify(exampleJevDraft()) })
    const run = engine.start(session.id, randomUUID(), request)
    expect((await complete(engine, run.id)).error).toContain('timed out')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('marks an abandoned durable intent interrupted instead of replaying it', async () => {
    const w = setup(), run = w.engine.start(w.session.id, randomUUID(), request)
    await complete(w.engine, run.id)
    database.db.prepare("UPDATE jev_runs SET status='running',owner=?,body=? WHERE id=?").run(2_000_000_000, JSON.stringify({ ...run, status: 'running' }), run.id)
    const fetcher = vi.fn<typeof fetch>(), other = new Runtime({ fetch: fetcher }); engines.push(other)
    expect(other.run(run.id).status).toBe('interrupted')
    expect(fetcher).not.toHaveBeenCalled()
  })
})

it('preserves workspace creation identity and validates unfinished editor drafts', async () => {
  const w = setup()
  expect(w.engine.create({ id: w.session.id, draft: w.session.draft })).toEqual(w.session)
  expect(() => w.engine.create({ id: w.session.id, title: 'Different intent', draft: w.session.draft })).toThrow(/different builder/)
  const malformed = exampleJevDraft(); malformed.questions[0].options = [null as any]
  expect(() => w.engine.create({ id: randomUUID(), draft: JSON.stringify(malformed) })).toThrow(/unreadable/)
  expect(w.engine.list()).toHaveLength(1)
})

it('recovers a failed result write without a second provider evaluation or endless spinner', async () => {
  const w = setup()
  database.db.exec("CREATE TRIGGER fail_jev_result BEFORE UPDATE ON jev_runs BEGIN SELECT RAISE(ABORT, 'injected disk failure'); END")
  const run = w.engine.start(w.session.id, randomUUID(), request)
  try {
    await vi.waitFor(() => expect(w.engine.run(run.id).status).toBe('completed'))
    expect(w.engine.run(run.id).result).toEqual(answer)
    expect(w.engine.runs(w.session.id).runs[0].storageWarning).toContain('could not be saved')
    expect(w.fetcher).toHaveBeenCalledTimes(1)
  } finally { database.db.exec('DROP TRIGGER fail_jev_result') }
  expect(w.engine.run(run.id).storageWarning).toBeUndefined()
  expect(w.engine.run(run.id).result).toEqual(answer)
  expect(w.engine.start(w.session.id, run.id, request).status).toBe('completed')
  expect(w.fetcher).toHaveBeenCalledTimes(1)
})

it('keeps structured Memories last without changing the shared state or original request', async () => {
  const w = setup(undefined, 'Remember the rubric.')
  const input = { ...request, questions: { refund: { type: 'noul' as const, instructions: { question: 'Is a refund requested?', examples: ['refund'] } } } }
  const effective = w.engine.effective(input)
  expect(effective.questions.refund.instructions).toEqual([input.questions.refund.instructions, { Memories: 'Remember the rubric.' }])
  expect(effective.state).toEqual(input.state)
  expect(input.questions.refund.instructions).not.toHaveProperty('Memories')
})

it('accepts zero probabilities and fractional scores, but rejects an invalid score legend', () => {
  const input: JevRequest = { ...request, questions: { rating: { type: 'score', instructions: 'Rate urgency', criteria: ['No deadline', 'Needed now'] } } }
  const result = { model: 'jev-1.13.0', answers: { rating: { type: 'score', score: .25, confidence: .5, legend: { '0': 'No deadline', '1': 'Needed now' }, probabilities: { '0': .75, '1': .25 } } }, usage: { input_tokens: 0, output_tokens: 0 } }
  expect(validateJevResult(result, input)).toBe(result)
  expect(() => validateJevResult({ ...result, answers: { rating: { ...result.answers.rating, legend: { '0': 'No deadline' } } } }, input)).toThrow(/legend/)
  expect(() => validateJevResult({ ...result, answers: { rating: { ...result.answers.rating, confidence: -1 } } }, input)).toThrow(/confidence/)
})

it('does not start an upstream evaluation when recording its intent fails', () => {
  const w = setup()
  database.db.exec("CREATE TRIGGER fail_jev_intent BEFORE INSERT ON jev_runs BEGIN SELECT RAISE(ABORT, 'injected intent failure'); END")
  try { expect(() => w.engine.start(w.session.id, randomUUID(), request)).toThrow(/intent failure/); expect(w.fetcher).not.toHaveBeenCalled() }
  finally { database.db.exec('DROP TRIGGER fail_jev_intent') }
})


it('captures immutable requests while the builder continues editing its criteria', () => {
  const draft = exampleJevDraft()
  const captured = requestFromDraft(draft)
  draft.questions[2].levels[0] = 'A newer unsent rubric'
  expect(captured.questions.frustration.criteria).toEqual(['Calm and neutral', 'Concerned but civil', 'Very angry or hostile'])
  expect(requestFromDraft(draft).questions.frustration.criteria).not.toEqual(captured.questions.frustration.criteria)
})
