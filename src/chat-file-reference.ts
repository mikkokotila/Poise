// Recognize local Markdown destinations without turning arbitrary schemes
// into navigation. The server separately authorizes every actual file read.
export interface ChatFileReference { path: string, line?: number, endLine?: number }

export function chatFileReference(value: string): ChatFileReference | null {
  if (!value || value.length > 4096) return null
  let raw = value.trim()
  if (/^file:\/\//i.test(raw)) {
    try {
      const url = new URL(raw)
      if (url.hostname && url.hostname !== 'localhost') return null
      if (url.search) return null
      raw = url.pathname + url.hash
    } catch { return null }
  } else if (/^[a-z][a-z\d+.-]*:/i.test(raw)) return null
  const hash = raw.indexOf('#')
  const fragment = hash < 0 ? '' : raw.slice(hash + 1)
  let path: string
  try { path = decodeURIComponent(hash < 0 ? raw : raw.slice(0, hash)) } catch { return null }
  if (!path || path.startsWith('//') || /[\x00-\x1f\x7f<>"'\\?]/.test(path)) return null
  // A URI encoded into a relative path is still not a local filename.
  if (/^[a-z][a-z\d+.-]*:/i.test(path)) return null
  let match = /^L?(\d+)(?:-L?(\d+))?$/.exec(fragment)
  if (!fragment) {
    const suffix = /:(\d+)(?::\d+)?$/.exec(path)
    if (suffix) { match = suffix; path = path.slice(0, suffix.index) }
  }
  if (!path || path === '.' || path === '..') return null
  if (!match) return { path }
  const line = Number(match[1]), endLine = Number(match[2] || match[1])
  if (!Number.isSafeInteger(line) || line < 1 || !Number.isSafeInteger(endLine) || endLine < line) return null
  return { path, line, endLine }
}

export interface ChatFilePreview {
  path: string
  text: string
  line?: number
  endLine?: number
  truncated: boolean
}
