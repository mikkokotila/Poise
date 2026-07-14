import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { enforceApiRequest, HttpError, readJson, setApiHeaders } from '../server/http'

function request(options: {
  body?: string
  contentType?: string
  host?: string
  origin?: string
  remoteAddress?: string
  url?: string
} = {}): IncomingMessage {
  const stream = Readable.from(options.body ? [Buffer.from(options.body)] : [])
  return Object.assign(stream, {
    headers: {
      host: options.host ?? '127.0.0.1:5555',
      ...(options.contentType ? { 'content-type': options.contentType } : {}),
      ...(options.origin ? { origin: options.origin } : {}),
    },
    method: 'POST',
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
    url: options.url ?? '/api/settings',
  }) as unknown as IncomingMessage
}

describe('local API boundary', () => {
  it('sandboxes API documents under the privileged local origin', () => {
    const headers = new Map<string, string | number | readonly string[]>()
    const response = {
      setHeader: (name: string, value: string | number | readonly string[]) => {
        headers.set(name, value)
      },
    } as unknown as ServerResponse

    setApiHeaders(response)

    expect(headers.get('Content-Security-Policy')).toContain("default-src 'none'")
    expect(headers.get('Content-Security-Policy')).toContain('sandbox')
  })

  it('accepts same-origin browser requests', () => {
    expect(() => enforceApiRequest(request({
      origin: 'http://127.0.0.1:5555',
    }))).not.toThrow()
  })

  it('accepts bracketed IPv6 loopback hosts', () => {
    expect(() => enforceApiRequest(request({
      host: '[::1]:5555',
      origin: 'http://[::1]:5555',
      remoteAddress: '::1',
    }))).not.toThrow()
  })

  it('rejects cross-origin browser requests', () => {
    expect(() => enforceApiRequest(request({
      origin: 'https://attacker.example',
    }))).toThrowError(new HttpError(403, 'request origin is not allowed'))
  })

  it('rejects an origin with a different scheme', () => {
    expect(() => enforceApiRequest(request({
      origin: 'https://127.0.0.1:5555',
    }))).toThrowError(new HttpError(403, 'request origin is not allowed'))
  })

  it('rejects non-loopback non-browser requests', () => {
    expect(() => enforceApiRequest(request({ remoteAddress: '192.0.2.10' })))
      .toThrowError(/must originate from loopback/)
  })

  it('parses bounded JSON requests', async () => {
    await expect(readJson<{ ok: boolean }>(request({
      body: '{"ok":true}',
      contentType: 'application/json; charset=utf-8',
    }))).resolves.toEqual({ ok: true })
  })

  it('rejects unsupported content types and oversized bodies', async () => {
    await expect(readJson(request({ body: '{}', contentType: 'text/plain' })))
      .rejects.toMatchObject({ statusCode: 415 })
    await expect(readJson(request({
      body: JSON.stringify({ value: 'x'.repeat(256) }),
      contentType: 'application/json',
    }), 64)).rejects.toMatchObject({ statusCode: 413 })
  })
})
