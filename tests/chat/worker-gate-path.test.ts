import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CLAUDE_SUBSCRIPTION_CLI } from '../../server/process'
import { WORKER_GATE } from '../../server/chat/worker'

describe('worker gate location', () => {
  it('sits next to the subscription wrapper, so the production bundle finds it too', () => {
    // The bundle is one directory deep (dist/server.js) like server/process.ts;
    // a path relative to server/chat/worker.ts would point outside the repo.
    expect(WORKER_GATE).toBe(join(dirname(CLAUDE_SUBSCRIPTION_CLI), 'chat-worker-gate.mjs'))
    expect(existsSync(WORKER_GATE)).toBe(true)
    expect(existsSync(CLAUDE_SUBSCRIPTION_CLI)).toBe(true)
  })
})
