import type { JevRequest, Json } from '../../src/jev-types'
/** Protocol fixture only: this function never uses an external network. */
export function jevFixture() {
  const calls: JevRequest[] = []
  const fetcher: typeof fetch = async (_url, options) => {
    const input = JSON.parse(String(options?.body)) as JevRequest
    calls.push(input)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, input.state === 'JEV_TEST_WAIT' ? 5000 : 100)
      options?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('aborted', 'AbortError')) }, { once: true })
    })
    if (input.state === 'JEV_TEST_LIMIT') return new Response('', { status: 429 })
    if (input.state === 'JEV_TEST_BAD') return Response.json({ model: 'jev-fixture', answers: {}, usage: { input_tokens: 10, output_tokens: 0 } })
    const answers = Object.fromEntries(Object.entries(input.questions).map(([id, q]) => {
      if (q.type === 'noul') return [id, { type: 'noul', noul: .95 }]
      if (q.type === 'choice') {
        const names = Object.keys(q.criteria as object)
        return [id, { type: 'choice', choice: names[0], confidence: .8, probabilities: Object.fromEntries(names.map((name, i) => [name, names.length === 1 ? 1 : i === 0 ? .9 : .1 / (names.length - 1)])) }]
      }
      const levels = q.criteria as Json[]
      return [id, { type: 'score', score: .75 * (levels.length - 1), confidence: .6, legend: Object.fromEntries(levels.map((level, i) => [String(i), level])), probabilities: Object.fromEntries(levels.map((_, i) => [String(i), i === 0 ? .25 : i === levels.length - 1 ? .75 : 0])) }]
    }))
    return Response.json({ model: 'jev-1.13.0', answers, usage: { input_tokens: 150, output_tokens: 30 } })
  }
  return { fetcher, calls }
}
