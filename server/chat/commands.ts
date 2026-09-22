// Shared prefix parsing for the composer and runtime. Slashes in prose stay literal.
export interface ChatCommandChain {
  model?: string
  /** Names only: definition bodies are never parsed as command syntax. */
  switches?: string[]
  create?: boolean
  context?: 'compact' | 'reset'
  review: boolean
  queue: boolean
  text: string
  missingModel: boolean
}

export function parseChatCommandChain(text: string, knownSwitches: ReadonlySet<string> = new Set()): ChatCommandChain {
  const result: ChatCommandChain = { review: false, queue: false, text: text.trim(), missingModel: false }
  for (;;) {
    const match = /^\/([a-z][a-z0-9_-]*)(?=\s|$)/i.exec(result.text)
    if (!match) return result
    const name = match[1].toLowerCase()
    if (!['model', 'review', 'queue', 'compact', 'reset', 'create'].includes(name) && !knownSwitches.has(name)) return result
    result.text = result.text.slice(match[0].length).trimStart()
    if (name === 'create') { result.create = true; return result }
    if (knownSwitches.has(name) && !['model', 'review', 'queue', 'compact', 'reset'].includes(name)) {
      result.switches ??= []
      if (!result.switches.includes(name)) result.switches.push(name)
    } else if (name === 'review') result.review = true
    else if (name === 'queue') result.queue = true
    else if (name === 'compact' || name === 'reset') { if (result.context !== 'reset') result.context = name }
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
  return [chain.context ? `/${chain.context}` : '', chain.review ? '/review' : '', ...(chain.switches || []).map(name => `/${name}`), chain.create ? '/create' : '', chain.text].filter(Boolean).join(' ')
}

/** Locate the model switch being completed without consuming a following command. */
export function modelCompletion(text: string, knownSwitches: ReadonlySet<string> = new Set()): { start: number, end: number, query: string } | null {
  let offset = 0
  for (;;) {
    const head = /^\s*\/([a-z][a-z0-9_-]*)(?=\s|$)/i.exec(text.slice(offset))
    if (!head || (!['model', 'review', 'queue', 'compact', 'reset'].includes(head[1].toLowerCase()) && !knownSwitches.has(head[1].toLowerCase()))) return null
    const start = offset
    offset += head[0].length
    offset += /^\s*/.exec(text.slice(offset))![0].length
    if (head[1].toLowerCase() === 'model') {
      const query = /^[^\s/]*/.exec(text.slice(offset))![0]
      return { start, end: offset + query.length, query }
    }
  }
}
