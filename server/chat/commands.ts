// Shared prefix parsing for the composer and runtime. Slashes in prose stay literal.
export interface ChatCommandChain {
  model?: string
  review: boolean
  queue: boolean
  text: string
  missingModel: boolean
}

export function parseChatCommandChain(text: string): ChatCommandChain {
  const result: ChatCommandChain = { review: false, queue: false, text: text.trim(), missingModel: false }
  for (;;) {
    const match = /^\/(model|review|queue)(?=\s|$)/i.exec(result.text)
    if (!match) return result
    const name = match[1].toLowerCase()
    result.text = result.text.slice(match[0].length).trimStart()
    if (name === 'review') result.review = true
    else if (name === 'queue') result.queue = true
    else {
      const identity = /^([^\s/]+)(?=\s|$)/.exec(result.text)
      if (!identity) { result.missingModel = true; return result }
      result.model = identity[1]
      result.text = result.text.slice(identity[0].length).trimStart()
    }
  }
}

/** A queued row's selected model takes precedence over its old textual prefix. */
export function commandBody(chain: ChatCommandChain): string {
  return `${chain.review ? '/review' : ''}${chain.review && chain.text ? ' ' : ''}${chain.text}`
}

/** Locate the model switch being completed without consuming a following command. */
export function modelCompletion(text: string): { start: number, end: number, query: string } | null {
  let offset = 0
  for (;;) {
    const head = /^\s*\/(model|review|queue)(?=\s|$)/i.exec(text.slice(offset))
    if (!head) return null
    const start = offset
    offset += head[0].length
    offset += /^\s*/.exec(text.slice(offset))![0].length
    if (head[1].toLowerCase() === 'model') {
      const query = /^[^\s/]*/.exec(text.slice(offset))![0]
      return { start, end: offset + query.length, query }
    }
  }
}
