/** TypeSafe System One contract: https://docs.typesafe.ai/api */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type Description = string | Json[] | { [key: string]: Json }
export type Primitive = 'noul' | 'choice' | 'score'
export interface JevQuestion { type: Primitive; instructions: Description; criteria?: Json }
export interface JevRequest { model: string; state: Description; questions: Record<string, JevQuestion> }
export type JevAnswer = { type: 'noul'; noul: number } | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number } | { type: 'score'; score: number; legend: Record<string, Json>; probabilities: Record<string, number>; confidence: number }
export interface JevResult { model: string; answers: Record<string, JevAnswer>; usage: { input_tokens: number; output_tokens: number } }
export interface JevSession { id: string; title: string; revision: number; draft: string; createdAt: string; updatedAt: string }
export interface JevRun { id: string; sessionId: string; status: 'running' | 'completed' | 'error' | 'cancelled' | 'interrupted'; input?: JevRequest; request: JevRequest; result?: JevResult; error?: string; storageWarning?: string; startedAt: string; finishedAt?: string; durationMs?: number }
export const JEV_REQUEST_BYTES = 1024 * 1024
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)
export function record(v: unknown): v is Record<string, unknown> { return !!v && typeof v === 'object' && !Array.isArray(v) }
function description(v: unknown): v is Description { return typeof v === 'string' ? !!v.trim() : Array.isArray(v) || record(v) }
function fail(message: string): never { throw new Error(message) }
function keys(value: Record<string, unknown>, allowed: string[], path: string) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${path}: unknown field “${key}”.`)
}
/** Validate the original structure; never silently repair or truncate it. */
export function validateJevRequest(value: unknown): JevRequest {
  if (!record(value)) fail('The request must be a JSON object.')
  keys(value, ['state', 'model', 'questions'], 'Request')
  if (typeof value.model !== 'string' || !/^jev-[a-zA-Z0-9][a-zA-Z0-9.\-]{0,99}$/.test(value.model)) fail('Choose a Jev model or alias, such as jev-latest.')
  if (!description(value.state)) fail('State: add the text or JSON object/array to evaluate.')
  if (!record(value.questions) || !Object.keys(value.questions).length) fail('Add at least one question.')
  if (Object.keys(value.questions).length > 1024) fail('Poise supports up to 1,024 questions in one request.')
  for (const [id, q] of Object.entries(value.questions)) {
    if (!id.trim() || id.length > 200) fail('Each question needs a unique ID of 1–200 characters.')
    if (!record(q)) fail(`${id}: the question must be an object.`)
    keys(q, ['type', 'instructions', 'criteria'], id)
    if (!['noul', 'choice', 'score'].includes(String(q.type))) fail(`${id}: choose Noul, Choice or Score.`)
    if (!description(q.instructions)) fail(`${id}: write a complete question in Instructions.`)
    if (q.type === 'choice') {
      if (!record(q.criteria)) fail(`${id}: Choice options must be a map of names to descriptions.`)
      const options = Object.entries(q.criteria)
      if (options.length < 2 || options.length > 255) fail(`${id}: use 2–255 Choice options.`)
      for (const [name, d] of options) if (!name.trim() || !(d === null || description(d))) fail(`${id}: every option needs a name and an optional text/JSON description.`)
    } else if (q.type === 'score') {
      if (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > 10 || !q.criteria.every(description)) fail(`${id}: Score needs 2–10 ordered, descriptive levels.`)
    } else if (q.criteria !== undefined) {
      if (!record(q.criteria)) fail(`${id}: Noul criteria must describe true and/or false.`)
      keys(q.criteria, ['true', 'false'], `${id} criteria`)
      if (!Object.values(q.criteria).every(description)) fail(`${id}: describe what yes or no means, or omit criteria.`)
    }
  }
  const walk = (v: unknown, depth: number): void => {
    if (depth > 50) fail('JSON nesting exceeds 50 levels.')
    if (typeof v === 'number' && !Number.isFinite(v)) fail('JSON numbers must be finite.')
    if (v === undefined || typeof v === 'function' || typeof v === 'bigint') fail('Use only JSON values.')
    if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x, depth + 1)
  }
  walk(value, 0)
  if (new TextEncoder().encode(JSON.stringify(value)).length > JEV_REQUEST_BYTES) fail('Request exceeds Poise’s 1 MiB limit. Nothing was truncated.')
  return value as unknown as JevRequest
}
export function validateJevResult(value: unknown, request: JevRequest): JevResult {
  if (!record(value) || typeof value.model !== 'string' || !/^jev-[\w.-]+$/.test(value.model) || !record(value.answers) || !record(value.usage)) fail('JEV returned an unreadable typed response.')
  const probability = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1
  if (Object.keys(value.answers).length !== Object.keys(request.questions).length) fail('JEV returned a different number of answers than requested.')
  for (const [id, q] of Object.entries(request.questions)) {
    const a = value.answers[id]
    if (!own(value.answers, id) || !record(a) || a.type !== q.type) fail(`JEV returned a missing or wrong answer type for “${id}”.`)
    if (q.type === 'noul') { if (!probability(a.noul)) fail(`Invalid Noul probability for “${id}”.`) }
    else {
      if (!probability(a.confidence) || !record(a.probabilities)) fail(`Invalid confidence/distribution for “${id}”.`)
      const expected = q.type === 'choice' ? Object.keys(q.criteria as object) : (q.criteria as Json[]).map((_, i) => String(i))
      if (Object.keys(a.probabilities).length !== expected.length || !expected.every(k => own(a.probabilities as object, k) && probability((a.probabilities as Record<string, unknown>)[k]))) fail(`The “${id}” distribution does not match its criteria.`)
      const sum = Object.values(a.probabilities).reduce<number>((total, n) => total + (n as number), 0)
      if (Math.abs(sum - 1) > .02) fail(`The “${id}” probabilities do not sum to one.`)
      if (q.type === 'choice' && (typeof a.choice !== 'string' || !expected.includes(a.choice))) fail(`JEV chose an unknown option for “${id}”.`)
      if (q.type === 'score' && (typeof a.score !== 'number' || !Number.isFinite(a.score) || a.score < 0 || a.score > expected.length - 1 || !record(a.legend) || Object.keys(a.legend).length !== expected.length || !expected.every(k => own(a.legend as object, k) && description((a.legend as Record<string, unknown>)[k])))) fail(`Invalid Score or legend for “${id}”.`)
    }
  }
  for (const key of ['input_tokens', 'output_tokens']) if (!Number.isSafeInteger(value.usage[key]) || Number(value.usage[key]) < 0) fail('JEV returned invalid token usage.')
  return value as unknown as JevResult
}
