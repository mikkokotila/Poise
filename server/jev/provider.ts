import { validateJevResult, JEV_REQUEST_BYTES, type JevRequest, type JevResult } from '../../src/jev-types'

const API = 'https://api.typesafe.ai/v1/'
export interface JevModel { name: string; description: string; release_date: string }
/** Fixed provider origin; credentials are never accepted from a browser or put in a URL. */
async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel()
    const explanation = response.status === 401 || response.status === 403 ? 'JEV rejected the API key. Check JEV_API_KEY on the server.'
      : response.status === 429 || response.status === 529 ? 'JEV is rate-limited or busy. Wait briefly, then run again.'
      : response.status === 422 ? 'JEV rejected the request. Check its primitive definitions, model and context size.'
      : `JEV returned HTTP ${response.status}. Try again later.`
    throw new Error(explanation)
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('JEV returned an empty response.')
  const chunks: Uint8Array[] = []; let bytes = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.length
      if (bytes > 4 * JEV_REQUEST_BYTES) { await reader.cancel(); throw new Error('JEV response exceeds Poise’s 4 MiB limit.') }
      chunks.push(next.value)
    }
  } finally { reader.releaseLock() }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new Error('JEV returned invalid JSON. No typed result was accepted.') }
}
export async function evaluateJev(request: JevRequest, key: string, signal: AbortSignal, fetcher = fetch): Promise<JevResult> {
  const response = await fetcher(API + 'systemone', { method: 'POST', redirect: 'error',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal })
  const value = await readJson(response)
  signal.throwIfAborted()
  return validateJevResult(value, request)
}
export async function listJevModels(key: string, fetcher = fetch): Promise<JevModel[]> {
  const response = await fetcher(API + 'models', { redirect: 'error', headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) })
  const value = await readJson(response) as { models?: JevModel[] } | null
  if (!value || !Array.isArray(value.models) || !value.models.every(m => m && typeof m.name === 'string' && /^jev-[\w.-]+$/.test(m.name) && typeof m.description === 'string' && typeof m.release_date === 'string')) throw new Error('JEV returned an unreadable model list.')
  return value.models
}
