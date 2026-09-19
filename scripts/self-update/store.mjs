// Durable controller state. One JSON document holds every change, release,
// hold, in-flight switch and rollback operation; each commit rewrites it
// atomically and appends a journal receipt. The active-release pointer is a
// separate, deliberately tiny file because the stable launcher reads it on
// every service start and must not depend on the controller's schema.
//
// Recovery model: any step that has side effects outside this store (git,
// GitHub, a pointer switch, a restart) records its intent here first. After a
// crash the reconciler reads the intents back and resumes from what is
// actually observable — the remote branch, the PR, the health endpoint —
// rather than from what it hoped had happened.
import { appendLineDurable, ensurePrivateDirectory, readJson, writeJsonAtomic } from './atomic.mjs'
import { layout } from './paths.mjs'

export const STATE_VERSION = 1

export function emptyState() {
  return {
    version: STATE_VERSION,
    changes: {},
    releases: {},
    previousReleaseId: null,
    hold: null,
    switching: null,
    rollbacks: {},
    workers: {},
    update: { lastMainSha: null, lastCheckedAt: null, current: null },
    rejectedShas: [],
  }
}

function upgrade(document) {
  const base = emptyState()
  if (!document || typeof document !== 'object') return base
  if (document.version !== STATE_VERSION) {
    throw new Error(`unsupported self-update state version ${document.version}`)
  }
  return { ...base, ...document, update: { ...base.update, ...(document.update || {}) } }
}

export async function openStore(root, { now = () => new Date().toISOString() } = {}) {
  const paths = layout(root)
  await ensurePrivateDirectory(root)
  let state = upgrade(await readJson(paths.statePath, null))
  let queue = Promise.resolve()

  const store = {
    paths,
    get state() {
      return state
    },
    /**
     * Apply `mutate` to the state, persist it, then append a receipt. Commits
     * are serialised so two concurrent API calls cannot interleave writes.
     * Returns whatever `mutate` returns.
     */
    commit(event, mutate, details = {}) {
      const run = queue.then(async () => {
        const draft = structuredClone(state)
        const result = mutate(draft)
        await writeJsonAtomic(paths.statePath, draft)
        state = draft
        await appendLineDurable(paths.journalPath, JSON.stringify({ at: now(), event, ...details }))
        return result
      })
      queue = run.catch(() => {})
      return run
    },
    async receipt(event, details = {}) {
      await appendLineDurable(paths.journalPath, JSON.stringify({ at: now(), event, ...details }))
    },
    async reload() {
      state = upgrade(await readJson(paths.statePath, null))
      return state
    },
    async readActivePointer() {
      const pointer = await readJson(paths.activePointerPath, null)
      return validPointer(pointer) ? pointer : null
    },
    async writeActivePointer(pointer) {
      if (!validPointer(pointer)) throw new Error('refusing to write an invalid active-release pointer')
      await writeJsonAtomic(paths.activePointerPath, { ...pointer, updatedAt: now() })
    },
  }
  return store
}

export function validPointer(pointer) {
  return Boolean(pointer)
    && typeof pointer === 'object'
    && typeof pointer.id === 'string' && pointer.id.length > 0
    && typeof pointer.sha === 'string' && /^[0-9a-f]{40}$/.test(pointer.sha)
    && typeof pointer.root === 'string' && pointer.root.startsWith('/')
}

export const ACTIVE_CHANGE_STATES = new Set([
  'implementing', 'checking', 'awaiting_ci', 'merging', 'merged', 'deploying', 'verifying', 'reverting',
])

export function activeChange(state) {
  return Object.values(state.changes).find((change) => ACTIVE_CHANGE_STATES.has(change.state)) || null
}

const INTERNAL_CHANGE_KEYS = new Set([
  'sourceSessionId', 'check', 'deploy', 'finish', 'prepared', 'merge', 'rollbackId', 'revert', 'workspace',
])

/** The public Change DTO: internal bookkeeping stripped, canRevert resolved by the caller. */
export function publicChange(change, canRevert) {
  const dto = {}
  for (const [key, value] of Object.entries(change)) {
    if (!INTERNAL_CHANGE_KEYS.has(key) && value !== undefined) dto[key] = value
  }
  dto.canRevert = canRevert === true
  return dto
}
