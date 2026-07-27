import { describe, expect, it } from 'vitest'

import { slugFromEditorSession } from '../server/editor'

// server/chat.ts attaches the voice guide, the document's current body and the
// edit-proposal contract to a chat *only* when slugFromEditorSession matches.
// Annotation chats used to carry their own `ann-xxxxxxxx` id, which never
// matches, so "Ask the agent about this passage" reached the agent as nothing
// but the snippet in quotes — asked what a passage said, it answered "The
// working directory is empty."
//
// The editor now mints annotation sessions in this format, so these cases pin
// the contract the client depends on.
describe('editor chat session identity', () => {
  it('accepts the format the editor mints, including the uniqueness digits', () => {
    // `${Date.now()}${3 random digits}` — all digits, as the lookup requires.
    expect(slugFromEditorSession('editor-untitled-20260722112438933-1769500000000042'))
      .toBe('untitled-20260722112438933')
  })

  it('extracts slugs that themselves contain dashes', () => {
    const slug = 'untitled-20260722112438933-7ad2fea8-8827-42db-8799-dae466b6e4ac'
    expect(slugFromEditorSession(`editor-${slug}-1769500000000`)).toBe(slug)
  })

  it('rejects the old annotation-scoped ids that carried no document', () => {
    expect(slugFromEditorSession('ann-qncjuig3')).toBeNull()
    expect(slugFromEditorSession('ann-4f2a9c1b')).toBeNull()
  })

  it('rejects ids whose tail is not purely numeric', () => {
    expect(slugFromEditorSession('editor-some-slug-12a4')).toBeNull()
    expect(slugFromEditorSession('editor-some-slug-')).toBeNull()
  })

  it('rejects unrelated session ids', () => {
    expect(slugFromEditorSession('')).toBeNull()
    expect(slugFromEditorSession('card-123')).toBeNull()
  })
})
