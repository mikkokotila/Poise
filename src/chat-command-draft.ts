import type { ComposerDraft } from './views/chat-composer'

/** Match the same whitespace boundaries as the command parser, not longer names. */
function startsWithCommand(text: string, prefix: string): boolean {
  return text.startsWith(prefix) && (text.length === prefix.length || /\s/.test(text[prefix.length]))
}

/** Submitted and raw editor drafts serialize each selected switch exactly once. */
export function commandDraftText(draft: ComposerDraft): string {
  let text = draft.text
  const model = draft.model ? `/model ${draft.model}` : ''
  if (model && startsWithCommand(text, model)) text = text.slice(model.length).trimStart()
  const mode = draft.mode ? `/${draft.mode}` : ''
  if (mode && !startsWithCommand(text, mode)) text = `${mode} ${text}`
  return `${model}${model && text ? ' ' : ''}${text}`.trim()
}

export function editableCommandDraft(draft: ComposerDraft): ComposerDraft {
  let text = draft.text
  for (const prefix of [draft.model ? `/model ${draft.model}` : '', draft.mode ? `/${draft.mode}` : '']) {
    if (prefix && startsWithCommand(text, prefix)) text = text.slice(prefix.length).trimStart()
  }
  return { ...draft, text }
}
