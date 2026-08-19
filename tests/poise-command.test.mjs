import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { installPoiseCommand } from '../scripts/poise-command-install.mjs'
import { openPoise } from '../scripts/poise-command.mjs'

function health(status = 'ok') {
  return { status, scheduler: {}, claudeAuth: {}, callerRelease: {} }
}

describe('managed poise command', () => {
  it('opens an already running production service without touching launchd', async () => {
    const run = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
    const result = await openPoise({
      allowNonDarwin: true,
      probe: vi.fn().mockResolvedValue(health()),
      run,
      log: vi.fn(),
    })

    expect(result).toEqual({ action: 'opened', url: 'http://127.0.0.1:5555/', status: 'ok' })
    expect(run).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledWith('/usr/bin/open', ['http://127.0.0.1:5555/'])
  })

  it('opens degraded Poise because the dashboard carries the recovery UI', async () => {
    const run = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
    const result = await openPoise({
      allowNonDarwin: true,
      probe: vi.fn().mockResolvedValue(health('degraded')),
      run,
      log: vi.fn(),
    })

    expect(result.status).toBe('degraded')
    expect(run).toHaveBeenCalledWith('/usr/bin/open', ['http://127.0.0.1:5555/'])
  })

  it('starts only the managed launchd service when production is down', async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(health())
    const run = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })

    await openPoise({
      allowNonDarwin: true,
      uid: 501,
      probe,
      run,
      pause: vi.fn(),
      log: vi.fn(),
      openBrowser: false,
    })

    expect(run.mock.calls).toContainEqual([
      '/bin/launchctl', ['kickstart', 'gui/501/com.vaquum.poise'],
    ])
    expect(run.mock.calls.flat(2)).not.toContain('kill')
    expect(run.mock.calls.flat(2)).not.toContain('npm')
  })

  it('restarts only its launchd label after an unresponsive start', async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(health())
    const run = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })

    await openPoise({
      allowNonDarwin: true,
      uid: 501,
      probe,
      run,
      pause: vi.fn(),
      waitAttempts: 1,
      log: vi.fn(),
      openBrowser: false,
    })

    expect(run.mock.calls).toContainEqual([
      '/bin/launchctl', ['kickstart', '-k', 'gui/501/com.vaquum.poise'],
    ])
  })

  it('bootstraps an installed service when launchd registration is missing', async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(health())
    const run = vi.fn(async (_command, args) => {
      if (args[0] === 'print') throw new Error('not registered')
      return { stdout: '', stderr: '' }
    })

    await openPoise({
      allowNonDarwin: true,
      home: '/Users/test',
      uid: 501,
      probe,
      run,
      fileExists: vi.fn().mockResolvedValue(true),
      pause: vi.fn(),
      log: vi.fn(),
      openBrowser: false,
    })

    expect(run.mock.calls).toContainEqual([
      '/bin/launchctl', [
        'bootstrap',
        'gui/501',
        '/Users/test/Library/LaunchAgents/com.vaquum.poise.plist',
      ],
    ])
  })

  it('runs the production installer when the managed service files are missing', async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(health())
    const run = vi.fn(async (_command, args) => {
      if (args[0] === 'print') throw new Error('not registered')
      return { stdout: '', stderr: '' }
    })
    const fileExists = vi.fn(async (path) => path.endsWith('install-production.mjs'))

    await openPoise({
      allowNonDarwin: true,
      home: '/Users/test',
      uid: 501,
      projectRoot: '/Users/test/Poise-production',
      probe,
      run,
      fileExists,
      pause: vi.fn(),
      log: vi.fn(),
      openBrowser: false,
    })

    expect(run.mock.calls).toContainEqual([
      process.execPath,
      ['/Users/test/Poise-production/scripts/install-production.mjs'],
      { cwd: '/Users/test/Poise-production', inherit: true },
    ])
  })

  it('installs an executable command with an immutable production root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'poise-command-test-'))
    const home = join(root, 'home')
    const sourceRoot = join(root, 'source')
    await mkdir(join(sourceRoot, 'scripts'), { recursive: true })
    await writeFile(join(sourceRoot, 'scripts', 'poise-command.mjs'), 'runtime\n')

    const installed = await installPoiseCommand({
      home,
      node: '/opt/node/bin/node',
      port: '6123',
      projectRoot: '/Users/test/Poise-production',
      sourceRoot,
    })

    expect(await readFile(installed.runtime, 'utf8')).toBe('runtime\n')
    const wrapper = await readFile(installed.command, 'utf8')
    expect(wrapper).toContain("POISE_PRODUCTION_ROOT='/Users/test/Poise-production'")
    expect(wrapper).toContain("POISE_PORT='6123'")
    expect(wrapper).toContain("exec '/opt/node/bin/node'")
    expect((await stat(installed.command)).mode & 0o777).toBe(0o755)
  })
})
