import type { ComposerDraft } from './views/chat-composer'

function body(draft: ComposerDraft): string {
  const prefix = draft.mode ? `/${draft.mode}` : ''
  return prefix && (draft.text === prefix || draft.text.startsWith(prefix + ' '))
    ? draft.text.slice(prefix.length).trimStart() : draft.text
}

/** A failed request must never erase text or attachments typed after Send. */
export function recoverDraft(submitted: ComposerDraft, current: ComposerDraft | null | undefined): ComposerDraft {
  const first = { ...submitted, text: body(submitted) }
  if (!current || (!current.text && !current.attachments.length && !current.mentions.length)) return first
  const second = { ...current, text: body(current) }
  const sameText = first.text === second.text && first.mode === second.mode
  const sameMode = first.mode === second.mode || !second.text
  const text = sameText ? second.text : sameMode
    ? [first.text, second.text].filter(Boolean).join('\n\n')
    : `Unsent ${first.mode ? '/' + first.mode + ' ' : ''}message:\n${first.text}\n\nCurrent ${second.mode ? '/' + second.mode + ' ' : ''}draft:\n${second.text}`
  return { text, mode: sameMode ? first.mode : null,
    attachments: [...new Map([...first.attachments, ...second.attachments].map(file => [file.id, file])).values()],
    mentions: [...new Map([...first.mentions, ...second.mentions].map(file => [file.path, file])).values()],
  }
}
