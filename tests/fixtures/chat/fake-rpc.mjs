// Shared plumbing for the fake agents: line-delimited JSON-RPC over the
// process's own stdio, plus a trace replayer that serves a recorded live
// session back to the adapter so the tests exercise the exact frames the
// real binaries produced.

import { createInterface } from 'node:readline'
import { readFileSync } from 'node:fs'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Return this from a request handler after answering by hand. */
export const HANDLED = Symbol('handled')

/** Wire the process stdio as a JSON-RPC peer. `handlers.request(method,
 *  params, id)` returns a result (or throws `{ code, message }`);
 *  `handlers.notification(method, params)` and `handlers.response(message)`
 *  are optional. Raw (non-JSON) lines can be written with `raw`. */
export function createPeer(handlers) {
  let nextId = 1
  const pending = new Map()
  const send = (message) => { process.stdout.write(JSON.stringify(message) + '\n') }
  const peer = {
    send,
    raw: (text) => { process.stdout.write(text) },
    notify: (method, params) => send({ jsonrpc: '2.0', method, params, emittedAtMs: Date.now() }),
    respond: (id, result) => send({ jsonrpc: '2.0', id, result }),
    respondError: (id, error) => send({ jsonrpc: '2.0', id, error }),
    /** Server → client request; resolves with `{ result }` or `{ error }`. */
    request: (method, params, id = `srv-${nextId++}`) => new Promise((resolve) => {
      pending.set(id, resolve)
      send({ jsonrpc: '2.0', id, method, params })
    }),
  }
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  lines.on('line', (line) => {
    if (!line.trim()) return
    let message
    try { message = JSON.parse(line) } catch { return }
    if (typeof message.method === 'string') {
      if (message.id !== undefined && message.id !== null) {
        Promise.resolve()
          .then(() => handlers.request(message.method, message.params ?? {}, message.id))
          .then(
            (result) => { if (result !== HANDLED) peer.respond(message.id, result ?? {}) },
            (error) => peer.respondError(message.id, { code: error?.code ?? -32000, message: error?.message ?? String(error) }),
          )
      } else {
        handlers.notification?.(message.method, message.params ?? {})
      }
      return
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const resolve = pending.get(message.id)
      pending.delete(message.id)
      resolve(message.error ? { error: message.error } : { result: message.result })
      return
    }
    handlers.response?.(message)
  })
  lines.on('close', () => { setTimeout(() => process.exit(0), 20) })
  return peer
}

/** Replay a recorded `{dir, msg}[]` trace. Each recorded client request
 *  owns the recorded server frames that followed it up to the next client
 *  request; when the adapter sends a request with the same method (matched
 *  in recording order) those frames are written back, with the recorded
 *  response carrying the adapter's request id. Client notifications and
 *  responses to server requests are accepted and ignored. */
export function replayTrace(path) {
  const trace = JSON.parse(readFileSync(path, 'utf8'))
  const segments = []
  const responses = new Map()
  for (let index = 0; index < trace.length; index++) {
    const entry = trace[index]
    // Only client requests open a segment; the client's own responses to
    // server requests (no method) are part of the flow, not boundaries.
    if (entry.dir !== 'out' || entry.msg.id === undefined || entry.msg.method === undefined) continue
    const frames = []
    for (let cursor = index + 1; cursor < trace.length; cursor++) {
      const next = trace[cursor]
      if (next.dir === 'out' && next.msg.id !== undefined && next.msg.method !== undefined) break
      if (next.dir === 'in') frames.push(next.msg)
    }
    segments.push({ method: entry.msg.method, id: entry.msg.id, frames, used: false })
  }
  for (const entry of trace) {
    if (entry.dir === 'in' && entry.msg.method === undefined && entry.msg.id !== undefined) responses.set(entry.msg.id, entry.msg)
  }
  // A request answered only after a later client request (the recording's
  // prompt answered after its interject) is answered when the replay reaches
  // that later segment, in the recorded order — never early.
  const answeredLater = new Set()
  for (const segment of segments) {
    for (const frame of segment.frames) {
      if (frame.method === undefined && frame.id !== undefined && frame.id !== segment.id) answeredLater.add(frame.id)
    }
  }
  const issued = new Map() // recorded request id → the adapter's id for it
  const peer = createPeer({
    request: async (method, _params, id) => {
      const segment = segments.find((candidate) => !candidate.used && candidate.method === method)
      if (!segment) throw { code: -32601, message: `trace has no ${method} left to replay` }
      segment.used = true
      issued.set(segment.id, id)
      let answered = false
      for (const frame of segment.frames) {
        if (frame.method === undefined && frame.id !== undefined) {
          if (frame.id === segment.id) {
            answered = true
            peer.send({ ...frame, id })
          } else if (issued.has(frame.id)) {
            peer.send({ ...frame, id: issued.get(frame.id) }) // the late answer to an earlier request
          }
          continue
        }
        peer.send(frame)
      }
      if (!answered && !answeredLater.has(segment.id)) {
        const late = responses.get(segment.id)
        if (late) peer.send({ ...late, id })
        else peer.respond(id, {})
      }
      return HANDLED
    },
    notification: () => {},
    response: () => {},
  })
  return peer
}
