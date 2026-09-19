// Public self-improvement state. Authority and filesystem operations live in
// the separately installed controller, not in this browser-facing contract.
export type SelfChangeState = 'implementing' | 'checking' | 'awaiting_ci' | 'merging' | 'merged' | 'deploying' | 'verifying' | 'live' | 'reverting' | 'reverted' | 'failed' | 'blocked' | 'superseded'
export interface SelfRelease { id: string, sha: string, root: string, createdAt: string, callerSha: string }
export interface SelfChange {
  id: string
  sessionId: string
  instance: string
  request: string
  title: string
  repository: 'mikkokotila/Poise'
  branch: string
  baseSha: string
  headSha?: string
  mergeSha?: string
  prNumber?: number
  prUrl?: string
  state: SelfChangeState
  error?: string
  createdAt: string
  updatedAt: string
  releaseId?: string
  previousReleaseId?: string
  canRevert: boolean
  sourceRevert?: { state: 'pending' | 'checking' | 'awaiting_ci' | 'merged' | 'conflict' | 'failed', prUrl?: string, error?: string }
}
export interface SelfUpdateStatus {
  enabled: boolean
  available: boolean
  reason?: string
  activeRelease: SelfRelease | null
  previousRelease: SelfRelease | null
  hold: { changeId: string, sha: string, reason: string } | null
  changes: SelfChange[]
  recoveryUrl?: string
}
export interface BuildIdentity { sha: string | null, releaseId: string | null }
export interface PreparedSelfChange { change: SelfChange, workspace: string, branch: string, baseSha: string }
