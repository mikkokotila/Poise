import { describe, expect, it } from 'vitest'
import { servicePath } from '../scripts/production-path.mjs'

describe('the PATH the launchd services run with', () => {
  it('puts the Caller release first, then the provider CLIs in ~/.local/bin, then the system', () => {
    expect(servicePath('/Users/me', '/Users/me/.poise/releases/caller/abc/venv/bin')).toBe(
      '/Users/me/.poise/releases/caller/abc/venv/bin:/Users/me/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    )
  })

  it('serves the doctor without a release', () => {
    expect(servicePath('/Users/me')).toBe('/Users/me/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin')
  })
})
