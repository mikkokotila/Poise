export interface ModelRefreshReport {
  checked_at?: string
  completed_at?: string
  changed?: boolean
  added?: string[]
  removed?: string[]
  error?: string
  families?: Record<string, { status: string, error?: string }>
  cli_updates?: Record<string, { status: string, before?: string, after?: string, path?: string, error?: string }>
}
export const MODEL_CHECK_TIMEOUT_MS = 15 * 60_000 + 15_000
function readableError(message: string): string {
  try { const data = JSON.parse(message); if (typeof data.result === 'string') return data.result.slice(0, 400) } catch { /* ordinary diagnostic */ }
  return message.replace(/\s+/g, ' ').slice(0, 400)
}
export function modelRefreshSummary(report: ModelRefreshReport): { text: string, level: 'ok' | 'error' } {
  const failures = Object.entries(report.cli_updates || {}).filter(([, item]) => item.status === 'unavailable').map(([name, item]) => `${name} CLI: ${readableError(item.error || 'latest version could not be verified')}`)
  failures.push(...Object.entries(report.families || {}).filter(([, item]) => item.status !== 'ok').map(([name, item]) => `${name}: ${readableError(item.error || 'no answer')}`))
  if (report.error) failures.unshift(readableError(report.error))
  if (!Object.keys(report.families || {}).length && !report.error) failures.push('No provider discovery results were returned')
  if (failures.length) return { text: `Model check incomplete. ${failures.join('; ')}. Existing model choices remain available.`, level: 'error' }
  const updated = Object.entries(report.cli_updates || {}).filter(([, item]) => item.status === 'updated').map(([name, item]) => `${name} ${item.before || 'unknown'} → ${item.after}`)
  return { text: `${report.changed ? 'Catalog updated.' : 'Catalog checked; nothing new.'}${updated.length ? ` CLIs updated: ${updated.join(', ')}.` : ''}`, level: 'ok' }
}
