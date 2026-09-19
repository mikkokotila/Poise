// Pure serialization helpers: memories are the last content, after context,
// runbooks, mentions and attachments. No parsing or rewriting of user text.
export function memorySuffix(memories: string | undefined): string {
  return memories?.trim() ? `\n\n[Memories]\n${memories}` : ''
}
export function appendMemories(text: string, memories: string | undefined): string {
  return text + memorySuffix(memories)
}
