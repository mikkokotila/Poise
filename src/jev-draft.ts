import { validateJevRequest, type Description, type JevRequest, type JevQuestion, type Primitive, type Json } from './jev-types'
export interface QuestionDraft {
  id: string; type: Primitive; instructions: Description
  options: { name: string; description: Json }[]; levels: Description[]
  yes: Description; no: Description
}
export interface JevDraft { model: string; state: string; format: 'text' | 'json'; questions: QuestionDraft[]; raw: string | null }
export function newQuestion(type: Primitive, id = 'question_1'): QuestionDraft {
  return { id, type, instructions: '', options: [{ name: '', description: null }, { name: '', description: null }], levels: ['', '', ''], yes: '', no: '' }
}
export function emptyJevDraft(): JevDraft { return { model: 'jev-latest', state: '', format: 'text', questions: [newQuestion('noul')], raw: null } }
export function requestFromDraft(draft: JevDraft, validate = true): JevRequest {
  if (draft.raw !== null) return validateJevRequest(JSON.parse(draft.raw))
  const ids = new Set<string>()
  const questions = draft.questions.map(q => {
    if (ids.has(q.id)) throw new Error(`Question ID “${q.id}” is repeated.`)
    ids.add(q.id)
    const question: JevQuestion = { type: q.type, instructions: q.instructions }
    if (q.type === 'choice') {
      const names = q.options.map(option => option.name)
      if (new Set(names).size !== names.length) throw new Error(`${q.id}: Choice option names must be unique.`)
      question.criteria = Object.fromEntries(q.options.map(option => [option.name, option.description === '' ? null : option.description]))
    } else if (q.type === 'score') question.criteria = q.levels
    else if (q.yes || q.no) question.criteria = { ...(q.yes ? { true: q.yes } : {}), ...(q.no ? { false: q.no } : {}) }
    return [q.id, question] as const
  })
  const request = { model: draft.model, state: draft.format === 'json' ? JSON.parse(draft.state) : draft.state, questions: Object.fromEntries(questions) }
  return structuredClone(validate ? validateJevRequest(request) : request)
}
export function draftFromRequest(request: JevRequest): JevDraft {
  validateJevRequest(request)
  return { model: request.model, state: typeof request.state === 'string' ? request.state : JSON.stringify(request.state, null, 2), format: typeof request.state === 'string' ? 'text' : 'json', raw: null,
    questions: Object.entries(request.questions).map(([id, q]) => ({ ...newQuestion(q.type, id), instructions: q.instructions,
      ...(q.type === 'choice' ? { options: Object.entries(q.criteria as Record<string, Json>).map(([name, description]) => ({ name, description })) } : {}),
      ...(q.type === 'score' ? { levels: q.criteria as Description[] } : {}),
      ...(q.type === 'noul' && q.criteria ? { yes: (q.criteria as Record<string, Description>).true || '', no: (q.criteria as Record<string, Description>).false || '' } : {}),
    })) }
}
export function nextQuestionId(questions: QuestionDraft[]): string { let n = 1; while (questions.some(q => q.id === `question_${n}`)) n++; return `question_${n}` }
export function exampleJevDraft(): JevDraft {
  return draftFromRequest({ model: 'jev-latest', state: 'My account was charged twice for the same order. Please refund the duplicate charge today; rent is due tomorrow.', questions: {
    request_type: { type: 'choice', instructions: 'What is the customer asking for?', criteria: { refund: 'Money returned', delivery: 'An update about shipping', information: 'Information without a transaction', other: 'None of these' } },
    urgent: { type: 'noul', instructions: 'Does the customer describe an explicit time-sensitive need?' },
    frustration: { type: 'score', instructions: 'How frustrated does the customer sound?', criteria: ['Calm and neutral', 'Concerned but civil', 'Very angry or hostile'] },
  } })
}
/** Local drafts may be incomplete; validate their editor shape, not the unfinished request. */
export function parseJevDraft(raw: string): JevDraft {
  if (new TextEncoder().encode(raw).length > 2 * 1024 * 1024) throw new Error('The saved builder exceeds 2 MiB.')
  const value = JSON.parse(raw) as JevDraft
  const desc = (v: unknown): boolean => typeof v === 'string' || (!!v && typeof v === 'object')
  if (!value || typeof value.state !== 'string' || typeof value.model !== 'string' || !['text', 'json'].includes(value.format) || !Array.isArray(value.questions) || !value.questions.length || value.questions.length > 1024 || !(value.raw === null || typeof value.raw === 'string')) throw new Error('The saved primitive builder draft is unreadable.')
  for (const q of value.questions) {
    if (!q || typeof q.id !== 'string' || !['noul', 'choice', 'score'].includes(q.type) || !desc(q.instructions) || !desc(q.yes) || !desc(q.no)
      || !Array.isArray(q.options) || q.options.length > 255 || !q.options.every(o => o && typeof o.name === 'string' && (o.description === null || desc(o.description)))
      || !Array.isArray(q.levels) || q.levels.length > 10 || !q.levels.every(desc)) throw new Error('The saved primitive question is unreadable.')
  }
  return value
}
