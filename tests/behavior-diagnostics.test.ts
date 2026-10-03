import { afterEach, describe, expect, it, vi } from 'vitest'
import { behaviorErrorMessage } from '../server/behavior-diagnostics'

afterEach(() => vi.unstubAllEnvs())
describe('behavior CLI diagnostics', () => {
  it.each([
    'error: checkout not found under /Users/example/dev: autonomio/autonomio',
    'error: GitHub 404: Not Found',
    'httpx.ConnectError: DNS lookup failed',
  ])('keeps the terminal cause: %s', (stderr) => {
    expect(behaviorErrorMessage(Object.assign(new Error('Command failed (1): github-interface'), {
      stderr: `Traceback (most recent call last):\n${stderr}\n`,
    }))).toBe(`Command failed (1): github-interface: ${stderr}`)
  })
  it('redacts credentials before truncation or persistence', () => {
    vi.stubEnv('GH_TOKEN', 'nonstandard-secret-value')
    const result = behaviorErrorMessage(Object.assign(new Error('nonstandard-secret-value'), {
      stderr: 'error: ghp_abcdef github_pat_abcdef Bearer private-secret https://user:password@example.org/path',
    }))
    expect(result).toBe('[redacted]: error: [redacted] [redacted] Bearer [redacted] https://[redacted]@example.org/path')
  })
  it('bounds output, strips control characters, and never exposes stdout', () => {
    const result = behaviorErrorMessage(Object.assign(new Error('failed'), {
      stderr: `\u001b[31m${'x'.repeat(1000)}`, stdout: 'secret credential',
    }))
    expect(result.length).toBe(300)
    expect(result).not.toContain('\u001b')
    expect(result).not.toContain('secret credential')
  })
})
