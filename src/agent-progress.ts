// Progress is optional observation data. It never determines a review outcome.
export const PHASE_LABELS = {
  preflight: 'Checking PR state',
  preparing_packet: 'Preparing PR packet',
  // Issue review: the issue and its sub-issues, then a fresh checkout.
  preparing_issue: 'Reading the issue',
  checking_out: 'Preparing a fresh checkout',
  waiting_provider: 'Waiting for provider',
  reasoning: 'Reasoning reported',
  responding: 'Receiving response',
  preparing_tool: 'Preparing tool request',
  tool_requested: 'Tool requested',
  tool_running: 'Tool execution reported',
  retrying: 'Provider retrying',
  recovering: 'Recovering with the fallback model',
  provider_error: 'Provider reported an error',
  provider_finished: 'Provider returned a result',
  validating: 'Validating result',
  submitting: 'GitHub command in progress',
  posting: 'Posting review comments',
  verifying: 'Verifying GitHub outcome',
  completed: 'Completed',
  superseded: 'Superseded',
  failed: 'Failed',
  interrupted: 'Worker interrupted',
  finished: 'Worker finished',
} as const

export interface ModelProgress {
  version: 1
  phase: keyof typeof PHASE_LABELS
  phase_started_at: string
  heartbeat_at: string
  last_provider_event_at: string | null
  deadline_at: string | null
  last_reasoning_at?: string | null
  reasoning_chars?: number
  reasoning_available?: boolean
  warning: string | null
  events: { at: string, message: string }[]
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

function timestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(value)
    && Number.isFinite(Date.parse(value))
}

export function parseProgress(value: unknown): ModelProgress | null {
  const row = record(value)
  if (!row || row.version !== 1 || typeof row.phase !== 'string'
    || !Object.prototype.hasOwnProperty.call(PHASE_LABELS, row.phase)
    || !timestamp(row.phase_started_at) || !timestamp(row.heartbeat_at)
    || (row.last_provider_event_at !== null && !timestamp(row.last_provider_event_at))
    || (row.deadline_at !== null && !timestamp(row.deadline_at))
    || (row.warning !== null && (typeof row.warning !== 'string' || row.warning.length > 160))
    || (row.last_reasoning_at !== undefined && row.last_reasoning_at !== null && !timestamp(row.last_reasoning_at))
    || (row.reasoning_chars !== undefined && (!Number.isSafeInteger(row.reasoning_chars) || Number(row.reasoning_chars) < 0))
    || (row.reasoning_available !== undefined && typeof row.reasoning_available !== 'boolean')
    || !Array.isArray(row.events) || row.events.length > 20) return null
  const events: ModelProgress['events'] = []
  for (const value of row.events) {
    const event = record(value)
    if (!event || !timestamp(event.at) || typeof event.message !== 'string' || event.message.length > 160) return null
    events.push({ at: event.at, message: event.message })
  }
  return {
    version: 1, phase: row.phase as ModelProgress['phase'],
    phase_started_at: row.phase_started_at, heartbeat_at: row.heartbeat_at,
    last_provider_event_at: row.last_provider_event_at, deadline_at: row.deadline_at,
    warning: row.warning, events,
    last_reasoning_at: row.last_reasoning_at as string | null | undefined,
    reasoning_chars: row.reasoning_chars as number | undefined,
    reasoning_available: row.reasoning_available as boolean | undefined,
  }
}
