// Keep bounded, redacted CLI evidence in health instead of an opaque exit code.
export function behaviorErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const stderr = (error as { stderr?: unknown } | null)?.stderr
  const detail = typeof stderr === 'string' ? stderr.trim().split('\n').at(-1)?.trim() : ''
  let result = detail ? `${message}: ${detail}` : message
  for (const [key, value] of Object.entries(process.env)) {
    if (/TOKEN|KEY|SECRET|PASSWORD|AUTH/i.test(key) && value && value.length >= 8) {
      result = result.split(value).join('[redacted]')
    }
  }
  return result
    .replace(/(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/g, '[redacted]')
    .replace(/(https?:\/\/)[^\s/]+@/g, '$1[redacted]@')
    .replace(/\b(Bearer|token)\s+[^\s,;"']+/gi, '$1 [redacted]')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .slice(0, 300)
}
