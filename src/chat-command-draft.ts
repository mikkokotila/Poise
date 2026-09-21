import type { ComposerDraft } from './views/chat-composer'

/** Submitted and raw editor drafts serialize each selected switch exactly once. */
export function commandDraftText(draft: ComposerDraft): string {
  let text = draft.text
  const model = draft.model ? `/model ${draft.model}` : ''
  if (model && (text === model || text.startsWith(model + ' '))) text = text.slice(model.length).trimStart()
  const mode = draft.mode ? `/${draft.mode}` : ''
  if (mode && text !== mode && !text.startsWith(mode + ' ')) text = `${mode} ${text}`
  return `${model}${model && text ? ' ' : ''}${text}`.trim()
}

export function editableCommandDraft(draft: ComposerDraft): ComposerDraft {
  let text = draft.text
  for (const prefix of [draft.model ? `/model ${draft.model}` : '', draft.mode ? `/${draft.mode}` : '']) {
    if (prefix && (text === prefix || text.startsWith(prefix + ' '))) text = text.slice(prefix.length).trimStart()
  }
  return { ...draft, text }
}
