import type { PromptInput } from './protocol'

/** Native steering is text-only. Carry the same verified file context as a
 * normal prompt, before shared instructions append Memories at the very end. */
export function steeringContext(input: PromptInput): string {
  const parts = [input.text]
  if (input.mentions.length) {
    parts.push('[File mentions]', ...input.mentions.map(mention => mention.path))
  }
  for (const file of input.attachments) {
    parts.push(`[Attached file: ${file.name}]`, `Path: ${file.path} (${file.size} bytes)`)
    if (file.text !== undefined) parts.push(file.text)
    else parts.push('Read this file from the workspace as needed.')
    parts.push('[End attached file]')
  }
  return parts.join('\n\n')
}
