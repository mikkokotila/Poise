// Operator CLI for the release controller.
//
//   node scripts/self-update/cli.mjs status [--json]
//   node scripts/self-update/cli.mjs tick
//   node scripts/self-update/cli.mjs rollback --expected <releaseId> [--change <changeId>]
//   node scripts/self-update/cli.mjs clear-hold
//   node scripts/self-update/cli.mjs report                 # bootstrap state of the root
//   node scripts/self-update/cli.mjs init --token-file <path> [--caller-sha <sha>] [--node-bin <dir>]
//   node scripts/self-update/cli.mjs install-controller     # copy modules into <root>/controller
//   node scripts/self-update/cli.mjs bootstrap-release --sha <sha>   # build and adopt the first release
//   node scripts/self-update/cli.mjs enable | disable
//   node scripts/self-update/cli.mjs daemon
//
// status/tick/rollback/clear-hold talk to the running daemon over the Unix
// socket; they never act on the store directly, so the daemon's lock and
// journal stay authoritative.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  adoptInitialRelease, bootstrapReport, configure, ensureBridgeKey, installControllerCopy, setEnabled,
} from './bootstrap.mjs'
import { ControlUnavailable, createControlClient, statusOrDisabled } from './client.mjs'
import { loadReleaseToken, readConfig } from './config.mjs'
import { createGit } from './git.mjs'
import { layout, selfUpdateRoot } from './paths.mjs'
import { createReleaseManager } from './releases.mjs'
import { createRunner } from './runner.mjs'

export function parseArguments(argv) {
  const [command, ...rest] = argv
  const options = {}
  const positional = []
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = rest[index + 1]
      if (next !== undefined && !next.startsWith('--')) {
        options[key] = next
        index += 1
      } else options[key] = true
    } else positional.push(arg)
  }
  return { command: command || 'status', options, positional }
}

function formatStatus(status) {
  const lines = []
  lines.push(`enabled: ${status.enabled}  available: ${status.available}${status.reason ? `  (${status.reason})` : ''}`)
  const release = (value) => (value ? `${value.id} ${value.sha.slice(0, 12)} ${value.root}` : 'none')
  lines.push(`active release:   ${release(status.activeRelease)}`)
  lines.push(`previous release: ${release(status.previousRelease)}`)
  if (status.hold) lines.push(`HOLD: ${status.hold.reason} (change ${status.hold.changeId}, ${status.hold.sha.slice(0, 12)})`)
  if (status.recoveryUrl) lines.push(`recovery ui: ${status.recoveryUrl}`)
  if (status.changes.length) {
    lines.push('changes:')
    for (const change of status.changes.slice(-20)) {
      lines.push(`  ${change.id.slice(0, 8)}  ${change.state.padEnd(13)} ${change.title}${change.prUrl ? `  ${change.prUrl}` : ''}${change.canRevert ? '  [can revert]' : ''}${change.error ? `\n            ${change.error.split('\n')[0]}` : ''}`)
    }
  }
  return lines.join('\n')
}

export async function runCli(argv, { root = selfUpdateRoot(), env = process.env, stdout = (line) => console.log(line), stderr = (line) => console.error(line), daemon = null } = {}) {
  const { command, options } = parseArguments(argv)
  const paths = layout(root)
  const client = createControlClient({ socketPath: paths.socketPath })

  switch (command) {
    case 'status': {
      const status = await statusOrDisabled(client)
      stdout(options.json ? JSON.stringify(status, null, 2) : formatStatus(status))
      return status.enabled ? 0 : 2
    }
    case 'tick': {
      const status = await client.tick()
      stdout(options.json ? JSON.stringify(status, null, 2) : formatStatus(status))
      return 0
    }
    case 'rollback': {
      if (typeof options.expected !== 'string') throw new Error('rollback requires --expected <releaseId>')
      const result = typeof options.change === 'string'
        ? await client.rollbackChange(options.change, { expectedReleaseId: options.expected })
        : await client.rollbackRelease({ expectedReleaseId: options.expected })
      stdout(JSON.stringify(result, null, 2))
      return 0
    }
    case 'clear-hold': {
      const status = await client.clearHold()
      stdout(formatStatus(status))
      return 0
    }
    case 'report': {
      stdout(JSON.stringify(await bootstrapReport(root), null, 2))
      return 0
    }
    case 'init': {
      if (typeof options['token-file'] !== 'string') throw new Error('init requires --token-file <path>')
      await loadReleaseToken(options['token-file'])
      const config = await configure(root, {
        tokenFile: resolve(options['token-file']),
        callerSha: typeof options['caller-sha'] === 'string' ? options['caller-sha'] : undefined,
        nodeBin: typeof options['node-bin'] === 'string' ? resolve(options['node-bin']) : undefined,
        productionPort: options['production-port'] ? Number(options['production-port']) : undefined,
        recoveryPort: options['recovery-port'] ? Number(options['recovery-port']) : undefined,
      })
      await ensureBridgeKey(root)
      stdout(`initialised ${root} (disabled until \`enable\`); bridge key at ${config.bridgeKeyFile}`)
      return 0
    }
    case 'install-controller': {
      const result = await installControllerCopy(root)
      stdout(`installed ${result.files.length} controller modules into ${result.directory}`)
      return 0
    }
    case 'bootstrap-release': {
      if (typeof options.sha !== 'string' || !/^[0-9a-f]{40}$/.test(options.sha)) throw new Error('bootstrap-release requires --sha <40-hex commit>')
      const { config } = await readConfig(root, env)
      const runner = createRunner({ log: stderr })
      const git = createGit({ runner, nodeBin: config.nodeBin, baseEnv: env })
      const releases = createReleaseManager({
        releasesDir: paths.releasesDir, logsDir: paths.logsDir, git, runner, nodeBin: config.nodeBin, baseEnv: env, callerSha: config.callerSha, log: stderr,
      })
      const token = await loadReleaseToken(config.tokenFile).catch(() => null)
      const release = await adoptInitialRelease(root, { sha: options.sha, stage: ({ id, sha }) => releases.stage({ id, sha, token }) })
      stdout(`adopted release ${release.id} (${release.sha}) at ${release.root}`)
      return 0
    }
    case 'enable':
    case 'disable': {
      const config = await setEnabled(root, command === 'enable')
      if (config.enabled) await loadReleaseToken(config.tokenFile)
      stdout(`self-update ${config.enabled ? 'enabled' : 'disabled'} in ${paths.configPath}`)
      return 0
    }
    case 'daemon': {
      const start = daemon || (await import('./daemon.mjs')).startDaemon
      const running = await start({ root, env, log: stdout })
      stdout(`controller running for ${running.root}; recovery ui at ${running.recoveryUrl}`)
      await new Promise((resolveStop) => {
        const shutdown = () => running.stop().finally(resolveStop)
        process.once('SIGINT', shutdown)
        process.once('SIGTERM', shutdown)
      })
      return 0
    }
    default:
      throw new Error(`unknown command ${command}`)
  }
}

const isEntrypoint = process.argv[1] ? resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)) : false
if (isEntrypoint) {
  try {
    process.exitCode = await runCli(process.argv.slice(2))
  } catch (error) {
    if (error instanceof ControlUnavailable) {
      console.error(`self-update controller is not running: ${error.message}`)
      process.exitCode = 2
    } else {
      console.error(error?.message || error)
      process.exitCode = 1
    }
  }
}
