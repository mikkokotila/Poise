import type { ClaudeAuthRuntime } from '../server/cache-plugin'
import type { ClaudeAuthSnapshot, ClaudeAuthStatus } from '../server/claude-auth'

export interface FakeClaudeAuthRuntime extends ClaudeAuthRuntime {
  readonly starts: number
  readonly stops: number
  readonly logins: number
  setStatus(status: ClaudeAuthStatus): void
}

export function createAuthenticatedClaudeAuth(): FakeClaudeAuthRuntime {
  let starts = 0
  let stops = 0
  let logins = 0
  let state: ClaudeAuthSnapshot = {
    status: 'authenticated',
    reason: null,
    checkedAt: '2026-07-15T09:00:00.000Z',
    verifiedAt: '2026-07-15T09:00:00.000Z',
    authMethod: 'claude.ai',
    subscriptionType: 'max',
    loginInProgress: false,
  }
  return {
    get starts() { return starts },
    get stops() { return stops },
    get logins() { return logins },
    start() { starts += 1 },
    async stop() { stops += 1 },
    snapshot() { return { ...state } },
    startLogin() {
      if (state.status === 'authenticated' || state.loginInProgress) return { ...state }
      logins += 1
      state = {
        ...state,
        status: 'signing_in',
        reason: 'Waiting for Claude subscription sign-in.',
        loginInProgress: true,
      }
      return { ...state }
    },
    setStatus(status) {
      state = {
        ...state,
        status,
        reason: status === 'authenticated' ? null : 'Claude subscription sign-in is required.',
        loginInProgress: status === 'signing_in',
      }
    },
  }
}
