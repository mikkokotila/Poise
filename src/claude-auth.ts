// Global Claude subscription health prompt.
//
// The server owns credential checks and the browser only renders its cached
// state. Healthy/checking states stay silent; actionable or degraded states
// share one accessible banner so repeated polls can never stack prompts.

type ClaudeAuthStatus =
  | 'checking'
  | 'authenticated'
  | 'reauth_required'
  | 'signing_in'
  | 'degraded'
  | 'unavailable'

interface ClaudeAuthState {
  status: ClaudeAuthStatus
  reason: string | null
  checkedAt: string | null
  verifiedAt: string | null
  authMethod: string | null
  subscriptionType: string | null
  loginInProgress: boolean
}

const HEALTHY_POLL_MS = 60_000
const UNHEALTHY_POLL_MS = 2_000
const REQUEST_TIMEOUT_MS = 15_000
const VISIBLE_STATUSES = new Set<ClaudeAuthStatus>([
  'reauth_required',
  'signing_in',
  'degraded',
  'unavailable',
])
const AUTH_STATUSES = new Set<ClaudeAuthStatus>([
  'checking',
  'authenticated',
  ...VISIBLE_STATUSES,
])
const LOGIN_STATUSES = new Set<ClaudeAuthStatus>(['reauth_required', 'degraded'])

const CHECKING_STATE: ClaudeAuthState = {
  status: 'checking',
  reason: null,
  checkedAt: null,
  verifiedAt: null,
  authMethod: null,
  subscriptionType: null,
  loginInProgress: false,
}

const DEGRADED_STATE: ClaudeAuthState = {
  ...CHECKING_STATE,
  status: 'degraded',
  reason: 'status_check_failed',
}

let initialized = false
let bannerEl: HTMLElement | null = null
let pollTimer: number | null = null
let refreshInProgress = false
let loginRequestInProgress = false
let stateEpoch = 0
let currentState: ClaudeAuthState = CHECKING_STATE

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function parseState(value: unknown): ClaudeAuthState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid Claude auth response')
  }
  const raw = value as Record<string, unknown>
  if (typeof raw.status !== 'string' || !AUTH_STATUSES.has(raw.status as ClaudeAuthStatus)) {
    throw new Error('invalid Claude auth status')
  }
  return {
    status: raw.status as ClaudeAuthStatus,
    reason: nullableString(raw.reason),
    checkedAt: nullableString(raw.checkedAt),
    verifiedAt: nullableString(raw.verifiedAt),
    authMethod: nullableString(raw.authMethod),
    subscriptionType: nullableString(raw.subscriptionType),
    loginInProgress: raw.loginInProgress === true,
  }
}

function effectiveStatus(state: ClaudeAuthState): ClaudeAuthStatus {
  return loginRequestInProgress || state.loginInProgress ? 'signing_in' : state.status
}

function removeBanner(): void {
  bannerEl?.remove()
  bannerEl = null
}

function bannerCopy(status: ClaudeAuthStatus): { title: string, message: string } {
  if (status === 'reauth_required') {
    return {
      title: 'Claude subscription sign-in required',
      message: 'Claude-backed work is paused. Sign in with the Claude Max or Pro subscription connected to this computer.',
    }
  }
  if (status === 'signing_in') {
    return {
      title: 'Complete Claude sign-in in your browser',
      message: 'Poise will verify the Claude subscription and resume Claude-backed work automatically.',
    }
  }
  if (status === 'unavailable') {
    return {
      title: 'Claude subscription check unavailable',
      message: 'Poise cannot reach Claude Code on this computer. It will keep checking automatically.',
    }
  }
  return {
    title: 'Claude subscription verification failed',
    message: 'Claude-backed work is paused. Reconnect the subscription now, or let Poise keep retrying automatically.',
  }
}

async function fetchWithDeadline(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    window.clearTimeout(timeout)
  }
}

function renderBanner(): void {
  const status = effectiveStatus(currentState)
  if (!VISIBLE_STATUSES.has(status)) {
    removeBanner()
    return
  }

  // Polls must not rewrite an unchanged live region: doing so would cause
  // screen readers to announce the same alert every two seconds.
  if (bannerEl?.dataset.status === status) return

  if (!bannerEl) {
    bannerEl = document.createElement('section')
    bannerEl.id = 'claude-auth-banner'
    bannerEl.setAttribute('role', 'alert')
    bannerEl.setAttribute('aria-live', 'assertive')
    bannerEl.setAttribute('aria-atomic', 'true')
    document.body.appendChild(bannerEl)
  }

  const copy = bannerCopy(status)
  bannerEl.dataset.status = status
  const text = document.createElement('div')
  text.className = 'claude-auth-copy'
  const title = document.createElement('strong')
  title.className = 'claude-auth-title'
  title.textContent = copy.title
  const message = document.createElement('span')
  message.className = 'claude-auth-message'
  message.textContent = copy.message
  text.append(title, message)

  bannerEl.replaceChildren(text)
  if (LOGIN_STATUSES.has(status)) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'claude-auth-login'
    button.textContent = status === 'reauth_required' ? 'Sign in with Claude' : 'Reconnect Claude'
    button.addEventListener('click', () => { void startLogin() })
    bannerEl.appendChild(button)
  }
}

function clearPoll(): void {
  if (pollTimer === null) return
  window.clearTimeout(pollTimer)
  pollTimer = null
}

function schedulePoll(): void {
  clearPoll()
  const healthy = effectiveStatus(currentState) === 'authenticated'
  pollTimer = window.setTimeout(() => { void refreshAuthState() }, healthy ? HEALTHY_POLL_MS : UNHEALTHY_POLL_MS)
}

async function refreshAuthState(): Promise<void> {
  if (refreshInProgress || loginRequestInProgress) return
  refreshInProgress = true
  clearPoll()
  const epoch = stateEpoch
  try {
    const response = await fetchWithDeadline('/api/claude-auth', {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(`Claude auth status ${response.status}`)
    const next = parseState(await response.json())
    if (epoch !== stateEpoch) return
    currentState = next
  } catch {
    if (epoch !== stateEpoch) return
    currentState = DEGRADED_STATE
  } finally {
    refreshInProgress = false
    if (epoch === stateEpoch && !loginRequestInProgress) {
      renderBanner()
      schedulePoll()
    }
  }
}

async function startLogin(): Promise<void> {
  if (loginRequestInProgress || !LOGIN_STATUSES.has(effectiveStatus(currentState))) return
  loginRequestInProgress = true
  stateEpoch += 1
  clearPoll()
  renderBanner()
  try {
    const response = await fetchWithDeadline('/api/claude-auth/login', {
      method: 'POST',
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`Claude sign-in ${response.status}`)
    currentState = parseState(await response.json())
  } catch {
    currentState = DEGRADED_STATE
  } finally {
    loginRequestInProgress = false
    renderBanner()
    schedulePoll()
  }
}

export function initClaudeAuth(): void {
  if (initialized) return
  initialized = true
  window.addEventListener('focus', () => { void refreshAuthState() })
  void refreshAuthState()
}
