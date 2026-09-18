// Caller keeps the ledger Swarm reads. Every chat turn is one row there
// (`agent-interface --record-turn`, see caller-contract.md): `start` writes
// a running row and prints its id, `finish` closes it. No process is run by
// Caller for these rows; Poise owns the agent. A Caller without the flag
// answers with its usage text and exit 2 — that is a compatibility error the
// user sees, never a silent fallback to the legacy chat path.

import { randomUUID } from 'node:crypto'
import { runFile } from '../process'
import { agentInterfaceCwd } from '../models'

const CLI = 'agent-interface'
export const CHAT_TURN_SOURCE = 'poise:chat'

export class CallerCompatError extends Error {
  readonly code = 'compat'
  constructor(message = 'Update Caller: recording chat turns is unavailable (agent-interface --record-turn)') {
    super(message)
    this.name = 'CallerCompatError'
  }
}

export interface CallerTurnStart {
  model: string
  sessionId: string
  repo?: string
  pr?: number
  correlationId?: string
}

export interface CallerTurnRecord {
  id: string
  status: string
  started_at?: string
  completed_at?: string | null
  time_elapsed?: string
  error?: string | null
}

export interface CallerTurns {
  start(input: CallerTurnStart): Promise<string>
  finish(callId: string, status: 'completed' | 'failed' | 'cancelled', error?: string): Promise<CallerTurnRecord>
}

function compatFromError(error: any): Error {
  const code = error?.code
  const stderr = String(error?.stderr || '')
  if (code === 2 || /usage: agent-interface|unrecognized arguments|first argument must be a behavior/i.test(stderr)) {
    return new CallerCompatError()
  }
  const detail = stderr.trim().split('\n').filter(Boolean).at(-1) || error?.message || String(error)
  return new Error(`agent-interface --record-turn failed: ${detail}`)
}

export const callerTurns: CallerTurns = {
  async start(input) {
    const args = ['--record-turn', 'start', '--model', input.model, '--session', input.sessionId, '--source', CHAT_TURN_SOURCE]
    if (input.repo) args.push('--repo', input.repo)
    if (input.pr) args.push('--pr', String(input.pr))
    args.push('--correlation-id', input.correlationId || randomUUID())
    let stdout: string
    try {
      ({ stdout } = await runFile(CLI, args, { cwd: agentInterfaceCwd(), timeoutMs: 30_000, maxOutputBytes: 64 * 1024 }))
    } catch (error) {
      throw compatFromError(error)
    }
    const id = stdout.trim().toLowerCase()
    if (!/^[0-9a-f]{32}$/.test(id)) throw new CallerCompatError()
    return id
  },

  async finish(callId, status, error) {
    if (!/^[0-9a-f]{32}$/.test(callId)) throw new Error('invalid call id')
    const args = ['--record-turn', 'finish', callId, '--status', status]
    if (error && status !== 'completed') {
      const text = error.slice(0, 4_000)
      args.push('--error', text.startsWith('-') ? ` ${text}` : text)
    }
    let stdout: string
    try {
      ({ stdout } = await runFile(CLI, args, { cwd: agentInterfaceCwd(), timeoutMs: 30_000, maxOutputBytes: 64 * 1024 }))
    } catch (err) {
      throw compatFromError(err)
    }
    try {
      const record = JSON.parse(stdout) as CallerTurnRecord
      if (typeof record?.id !== 'string' || typeof record.status !== 'string') throw new Error('malformed')
      return record
    } catch {
      throw new Error('agent-interface --record-turn finish returned malformed output')
    }
  },
}
