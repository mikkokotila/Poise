import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { RpcClosedError, StdioRpc } from '../server/chat/rpc'

const fixtures: Array<{ rpc: StdioRpc, streams: PassThrough[] }> = []
function fixture(maxLineBytes = 1024) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
  })
  const rpc = new StdioRpc(child as unknown as ChildProcess, { maxLineBytes, requestTimeoutMs: 1000 })
  fixtures.push({ rpc, streams: [child.stdin, child.stdout, child.stderr] })
  const receive = (message: unknown) => child.stdout.emit('data', Buffer.from(JSON.stringify(message) + '\n'))
  return { rpc, child, receive }
}
afterEach(() => {
  for (const { rpc, streams } of fixtures.splice(0)) {
    rpc.fail(new RpcClosedError('test cleanup'))
    for (const stream of streams) stream.destroy()
  }
})

describe('Chat RPC adversarial regression cases', () => {
  it('bounds an unterminated tail after a complete frame in the same chunk', () => {
    const { rpc, child } = fixture(64)
    child.stdout.emit('data', Buffer.from('{"method":"notice"}\n' + 'x'.repeat(65)))
    expect(rpc.isClosed).toBe(true)
  })

  it('processes a final stdout response even when exit arrived first', async () => {
    const { rpc, child, receive } = fixture()
    const result = rpc.request('last').then(value => ({ value }), error => ({ error }))
    child.emit('exit', 0, null)
    receive({ id: 1, result: 'complete' })
    child.stdout.emit('end')
    child.emit('close', 0, null)
    expect(await result).toEqual({ value: 'complete' })
  })

  it('fails outstanding requests when stdout ends but the process stays alive', async () => {
    const { rpc, child } = fixture()
    const result = rpc.request('never').catch(error => error)
    child.stdout.emit('end')
    expect(rpc.isClosed).toBe(true)
    expect(await result).toBeInstanceOf(Error)
  })

  it('does not dispatch a filesystem request with an object-valued id', async () => {
    const { rpc, receive } = fixture()
    const handler = vi.fn(() => ({}))
    rpc.onRequest('fs/write_text_file', handler)
    receive({ jsonrpc: '2.0', id: { invalid: true }, method: 'fs/write_text_file', params: {} })
    await new Promise(resolve => setImmediate(resolve))
    expect(handler).not.toHaveBeenCalled()
  })

  it('does not dispatch a repeated in-flight request twice', async () => {
    const { rpc, receive } = fixture()
    let finish!: (value: unknown) => void
    const pending = new Promise(resolve => { finish = resolve })
    const handler = vi.fn(() => pending)
    rpc.onRequest('fs/write_text_file', handler)
    const message = { jsonrpc: '2.0', id: 7, method: 'fs/write_text_file', params: {} }
    receive(message)
    receive(message)
    await new Promise(resolve => setImmediate(resolve))
    const invocations = handler.mock.calls.length
    finish({})
    await new Promise(resolve => setImmediate(resolve))
    expect(invocations).toBeLessThanOrEqual(1)
  })

  it('cleans up abort listeners when a request cannot be serialized', async () => {
    const { rpc } = fixture()
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    await expect(rpc.request('invalid', { value: 1n }, { signal: controller.signal })).rejects.toThrow()
    for (const [event, listener] of add.mock.calls) {
      if (event === 'abort') expect(remove.mock.calls.some(([name, fn]) => name === event && fn === listener)).toBe(true)
    }
  })
})
