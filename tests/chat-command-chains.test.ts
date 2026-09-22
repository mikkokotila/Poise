import { describe, expect, it } from 'vitest'
import { commandBody, modelCompletion, parseChatCommandChain } from '../server/chat/commands'
import { commandDraftText, editableCommandDraft } from '../src/chat-command-draft'
import { cleanDraft } from '../src/self-update-drafts'
import { recoverDraft } from '../src/chat-draft-recovery'
const draft = { text: '', attachments: [], mentions: [], mode: null }

describe('Chat command chains', () => {
  it.each(['/model opus-5-high /review inspect the claims', '/review /model opus-5-high inspect the claims'])(
    'parses model/review modifiers in %s', text => {
      expect(parseChatCommandChain(text)).toEqual({ model: 'opus-5-high', review: true, queue: false, missingModel: false, text: 'inspect the claims' })
    })
  it('composes queue/review/model and leaves a native command or prose intact', () => {
    const chain = parseChatCommandChain('/queue /model opus-5-high /review focus on /src files')
    expect(chain.queue).toBe(true); expect(commandBody(chain)).toBe('/review focus on /src files')
    expect(parseChatCommandChain('/model opus-5-high /compact keep the architecture')).toMatchObject({ context: 'compact', text: 'keep the architecture' })
  })
  it.each(['Explain /review and /model', '/models catalogue', '/Users/person/file', '```\n/review\n```'])(
    'does not execute a switch embedded in %s', text => {
      expect(parseChatCommandChain(text)).toEqual({ text, review: false, queue: false, missingModel: false })
    })
  it('does not mistake the following switch for a model identity', () => {
    expect(parseChatCommandChain('/model /review')).toMatchObject({ missingModel: true, text: '/review' })
    expect(parseChatCommandChain('/model')).toMatchObject({ missingModel: true })
  })
  it('completes a model without consuming earlier or later switches', () => {
    const text = '/queue /model opus /review correctness'
    const match = modelCompletion(text)!
    expect(match.query).toBe('opus')
    expect([text.slice(0, match.start).trimEnd(), text.slice(match.end).trimStart()].join(' ')).toBe('/queue /review correctness')
    expect(modelCompletion('Check /model opus')).toBeNull()
  })
  it('serializes recalled and submitted model chips once', () => {
    const selected = { ...draft, mode: 'review', model: 'opus-5-high', text: 'check the edge cases' }
    const text = commandDraftText(selected)
    expect(text).toBe('/model opus-5-high /review check the edge cases')
    expect(commandDraftText({ ...selected, text })).toBe(text)
    expect(editableCommandDraft({ ...selected, text })).toEqual(selected)
    expect(cleanDraft({ ...draft, model: selected.model })).toEqual({ ...draft, model: selected.model })
  })
  it('preserves two drafts with different models without applying the wrong one', () => {
    const first = { ...draft, model: 'opus-5-high', mode: 'review', text: '/model opus-5-high /review earlier' }
    const next = { ...draft, model: 'gpt-6-astra-max', text: 'newer task' }
    const restored = recoverDraft(first, next)
    expect(restored.model).toBeUndefined(); expect(restored.mode).toBeNull()
    expect(restored.text).toContain('/model opus-5-high /review earlier')
    expect(restored.text).toContain('/model gpt-6-astra-max newer task')
    expect(recoverDraft(first, draft)).toMatchObject({ model: 'opus-5-high', mode: 'review', text: 'earlier' })
  })
})

it.each(['\n', '\r\n', '\t', ' '])('QC2: restored command chips accept whitespace boundaries (%j)', separator => {
  const body = 'Check the proposal\nKeep the second line.'
  const selected = { ...draft, model: 'opus-5-high', mode: 'review', text: body }
  const sent = { ...selected, text: `/model opus-5-high${separator}/review${separator}${body}` }
  expect(editableCommandDraft(sent)).toEqual(selected)
  expect(commandDraftText(sent)).toBe(`/model opus-5-high /review${separator}${body}`)
  expect(commandDraftText(editableCommandDraft(sent))).toBe('/model opus-5-high /review ' + body)
  expect(recoverDraft(sent, draft)).toEqual(selected)
})

it('QC2: similarly named commands and model identities are not stripped from drafts', () => {
  expect(editableCommandDraft({ ...draft, mode: 'review', text: '/reviewer note' }).text).toBe('/reviewer note')
  expect(editableCommandDraft({ ...draft, model: 'opus-5-high', text: '/model opus-5-higher task' }).text).toBe('/model opus-5-higher task')
})

it.each(['/model opus-5-high /compact /review', '/queue /model opus-5-high /reset'])('parses context maintenance together with model selection: %s', text => {
  const chain = parseChatCommandChain(text)
  expect(chain.model).toBe('opus-5-high')
  expect(commandBody(chain)).toBe(text.includes('/reset') ? '/reset' : '/compact /review')
  expect(modelCompletion(text)?.query).toBe('opus-5-high')
})
it.each(['/compact /reset', '/reset /compact'])('does not lose a requested conversation reset: %s', text => {
  expect(parseChatCommandChain(text).context).toBe('reset')
})
