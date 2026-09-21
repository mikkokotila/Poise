import type { ComposerDraft } from './views/chat-composer'
import { commandDraftText, editableCommandDraft } from './chat-command-draft'

/** A failed request must never erase text or attachments typed after Send. */
export function recoverDraft(submitted: ComposerDraft, current: ComposerDraft | null | undefined): ComposerDraft {
  const first = editableCommandDraft(submitted)
  if (!current || (!current.text && !current.attachments.length && !current.mentions.length && !current.model && !current.mode)) return first
  const second = editableCommandDraft(current)
  const sameText = first.text === second.text && first.mode === second.mode && first.model === second.model
  const sameMode = (first.mode === second.mode && first.model === second.model) || (!second.text && !second.mode && !second.model)
  const text = sameText ? second.text : sameMode
    ? [first.text, second.text].filter(Boolean).join('\n\n')
    : first.model !== second.model
    ? `Unsent message:\n${commandDraftText(first)}\n\nCurrent draft:\n${commandDraftText(second)}`
    : `Unsent ${first.mode ? '/' + first.mode + ' ' : ''}message:\n${first.text}\n\nCurrent ${second.mode ? '/' + second.mode + ' ' : ''}draft:\n${second.text}`
  return { text, mode: sameMode ? first.mode : null, ...(sameMode && first.model ? { model: first.model } : {}),
    attachments: [...new Map([...first.attachments, ...second.attachments].map(file => [file.id, file])).values()],
    mentions: [...new Map([...first.mentions, ...second.mentions].map(file => [file.path, file])).values()],
  }
}
