// Fake AdapterHost for the adapter tests: spawns a fake agent script with
// node instead of the real binary, answers permissions and questions
// programmatically, and records every emitted event and log line.

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, sep } from 'node:path'
import type { ChatEvent } from '../../server/chat/protocol'
import type { AdapterHost, PermissionRequest, QuestionAnswers, QuestionRequest } from '../../server/chat/adapters/types'

export const FIXTURES = join(process.cwd(), 'tests', 'fixtures', 'chat')

export interface FakeHost extends AdapterHost {
  events: ChatEvent[]
  logs: string[]
  spawns: Array<{ command: string, args: readonly string[] }>
  permissions: PermissionRequest[]
  questions: QuestionRequest[]
  children: ChildProcess[]
  answerPermission: (request: PermissionRequest) => Promise<string> | string
  answerQuestion: (request: QuestionRequest) => Promise<QuestionAnswers> | QuestionAnswers
  /** Resolves when an event matching `predicate` has been emitted. */
  waitFor<T extends ChatEvent>(predicate: (event: ChatEvent) => event is T, timeoutMs?: number): Promise<T>
  waitFor(predicate: (event: ChatEvent) => boolean, timeoutMs?: number): Promise<ChatEvent>
  ofType<K extends ChatEvent['type']>(type: K): Array<Extract<ChatEvent, { type: K }>>
  /** Kills any fake still running. */
  dispose(): void
}

export function createFakeHost(script: string, extraArgs: string[] = []): FakeHost {
  const checkout = realpathSync(mkdtempSync(join(tmpdir(), 'poise-adapter-')))
  const waiters: Array<{ predicate: (event: ChatEvent) => boolean, resolve: (event: ChatEvent) => void }> = []
  const host: FakeHost = {
    sessionId: 'session-test',
    checkout,
    events: [],
    logs: [],
    spawns: [],
    permissions: [],
    questions: [],
    children: [],
    answerPermission: (request) => request.options.find((option) => option.kind === 'allow_once')?.id ?? request.options[0].id,
    answerQuestion: (request) => Object.fromEntries(request.questions.map((question) => [question.id, question.multiSelect ? [question.options[0]?.label ?? ''] : question.options[0]?.label ?? ''])),
    async spawn(command, args) {
      host.spawns.push({ command, args })
      const child = spawn(process.execPath, [join(FIXTURES, script), ...extraArgs], { cwd: checkout, stdio: ['pipe', 'pipe', 'pipe'] })
      host.children.push(child)
      return child
    },
    emit(event) {
      host.events.push(event)
      for (const waiter of [...waiters]) {
        if (waiter.predicate(event)) {
          waiters.splice(waiters.indexOf(waiter), 1)
          waiter.resolve(event)
        }
      }
    },
    async requestPermission(request) {
      host.permissions.push(request)
      return host.answerPermission(request)
    },
    async askQuestion(request) {
      host.questions.push(request)
      return host.answerQuestion(request)
    },
    // Mirrors the runtime: relative and absolute paths are both served, only
    // inside the checkout; ENOENT propagates with its code.
    async readTextFile(path) {
      const absolute = isAbsolute(path) ? path : join(checkout, path)
      if (absolute !== checkout && !absolute.startsWith(checkout + sep)) throw new Error(`path outside the checkout: ${path}`)
      return readFile(absolute, 'utf8')
    },
    async writeTextFile() { throw new Error('not used') },
    log(message) { host.logs.push(message) },
    waitFor(predicate: (event: ChatEvent) => boolean, timeoutMs = 5_000): Promise<any> {
      const found = host.events.find(predicate)
      if (found) return Promise.resolve(found)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.splice(waiters.findIndex((entry) => entry.resolve === settle), 1)
          reject(new Error(`no matching event within ${timeoutMs}ms; saw ${host.events.map((event) => event.type).join(', ')}`))
        }, timeoutMs)
        const settle = (event: ChatEvent) => { clearTimeout(timer); resolve(event) }
        waiters.push({ predicate, resolve: settle })
      })
    },
    ofType(type) {
      return host.events.filter((event) => event.type === type) as any
    },
    dispose() {
      for (const child of host.children) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }
    },
  }
  return host
}

export function prompt(text: string) {
  return { text, attachments: [], mentions: [] }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Waits until `check` returns true, polling. */
export async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not met in time')
    await sleep(10)
  }
}
