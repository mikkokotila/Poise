import { describe, expect, it } from 'vitest'
import { autoMergeInstructions, withAutoMergeInstructions } from '../../server/chat/auto-merge'

describe('shared Auto-merge instructions', () => {
  it('covers the whole requested batch across repositories, including verified merges and final questions', () => {
    const policy = autoMergeInstructions(true)
    for (const text of ['every repository', 'one PR', 'existing PRs', 'verify that each intended PR actually merged', 'entire requested', 'non-blocking questions until the very end', 'continue independent PRs', 'Do not stop at', 'protection requirements']) expect(policy).toContain(text)
  })
  it('does not alter ordinary sessions that never opted in', () => {
    const input = { text: 'Discuss this idea', attachments: [], mentions: [] }
    expect(withAutoMergeInstructions(input, undefined)).toBe(input)
  })
  it('preserves the request and its attachment/mention metadata', () => {
    const input = { text: 'Complete all these slices.', attachments: [{ id: 'a', name: 'plan.txt', path: 'plan.txt', size: 10 }], mentions: [{ path: 'README.md' }] }
    const native = withAutoMergeInstructions(input, true)
    expect(native.text).toContain('[User request]\nComplete all these slices.')
    expect(native.attachments).toBe(input.attachments)
    expect(native.mentions).toBe(input.mentions)
    expect(input.text).toBe('Complete all these slices.')
  })
  it('revokes prior mode instructions explicitly when turned off', () => {
    expect(autoMergeInstructions(false)).toContain('supersedes earlier Auto-merge')
    expect(autoMergeInstructions(false)).toContain('no longer standing permission')
    expect(autoMergeInstructions(true, true)).toContain('controller still owns')
    expect(autoMergeInstructions(true)).not.toContain('controller still owns')
  })
})
