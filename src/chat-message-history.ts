import type { SessionContext } from '../server/chat/protocol'
import type { ComposerDraft } from './views/chat-composer'
import type { TranscriptModel } from './views/chat-transcript'

export const MESSAGE_HISTORY_LIMIT = 10
export interface MessageHistoryEntry { id: string, draft: ComposerDraft }
export interface MessageHistorySnapshot { entries: MessageHistoryEntry[], loading?: boolean, error?: string | null }

/** Visible, acknowledged user messages only, oldest to newest within the last
 *  ten. Never read another conversation, or recall generated agent output,
 *  memories or an optimistic request whose delivery is still uncertain. */
export function recentMessages(model: TranscriptModel, context?: SessionContext): MessageHistoryEntry[] {
  const recent: MessageHistoryEntry[] = []
  const firstTurn = context?.kind === 'handoff' ? model.blocks.find(block => block.kind === 'turn') : null
  for (let i = model.blocks.length - 1; i >= 0 && recent.length < MESSAGE_HISTORY_LIMIT; i--) {
    const block = model.blocks[i]
    if (block.kind !== 'turn' || block.turn.optimistic) continue
    const turn = block.turn
    for (let j = turn.items.length - 1; j >= 0 && recent.length < MESSAGE_HISTORY_LIMIT; j--) {
      const item = turn.items[j]
      if (item.kind === 'steer' && (item.text.trim() || item.attachments?.length)) {
        recent.push({ id: item.key, draft: { text: item.text, mode: null, attachments: (item.attachments || []).map(file => ({ ...file })), mentions: (item.mentions || []).map(mention => ({ ...mention })) } })
      }
    }
    if (recent.length >= MESSAGE_HISTORY_LIMIT || block === firstTurn) continue
    const prompt = turn.prompt
    if (!prompt.text.trim() && !prompt.attachments.length) continue
    recent.push({ id: turn.key, draft: { text: prompt.text, mode: turn.queueItemId ? 'queue' : null, ...(turn.queueItemId && turn.model ? { model: turn.model } : {}),
      attachments: prompt.attachments.map(file => ({ ...file })), mentions: prompt.mentions.map(mention => ({ ...mention })) } })
  }
  return recent.reverse()
}

/** Collapse whitespace for the one-line list only; the recalled draft is exact. */
export function historyLabel(entry: MessageHistoryEntry): string {
  const draft = entry.draft
  const text = `${draft.mode ? '/' + draft.mode + ' ' : ''}${draft.text}`.replace(/\s+/g, ' ').trim()
  const files = draft.attachments.map(file => file.name).join(', ')
  return text ? text + (files ? ` · ${files}` : '') : files || 'Attachment message'
}
