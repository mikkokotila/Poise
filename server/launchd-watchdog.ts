// Production's timed jobs — the updater, the health monitor, the datastore
// sync — run on launchd StartInterval timers. launchd can stop firing those
// timers for the whole login session while everything else keeps running: a
// logout that is started and then cancelled (an app refuses to quit) leaves the
// session in "on-demand-only mode", and from then on every interval spawn is
// logged as "pending spawn, domain in on-demand-only mode" and never happens.
// On 2026-10-02 that silently froze production on an old commit for a day —
// merges stopped deploying, the monitor that should have noticed was itself a
// timed job, and nothing said so.
//
// The server is the one process that stays up through that state, so it keeps
// watch. Every minute it reads each job's launchd run count; a job that has not
// run for three of its intervals is started with `launchctl kickstart`, which
// is an explicit request and is honoured in on-demand-only mode. Kickstart is
// a no-op for a job that is already running, and a job whose timer is healthy
// never goes quiet long enough to be touched.
//
// Enabled only by the installer, which passes the labels it manages in
// POISE_LAUNCHD_WATCHDOG. A dev server or a test server never sets it, so it
// can never start a real production job.

import { execFile } from 'node:child_process'

export interface LaunchdJob {
  running: boolean
  runs: number
  intervalSeconds: number | null
}

export interface WatchState {
  runs: number
  // When the job last showed signs of life: running, or a new run counted.
  aliveAt: number
}

const TICK_MS = 60_000
const MIN_GRACE_MS = 180_000
const LAUNCHCTL_TIMEOUT_MS = 10_000

// `launchctl print` output for one service. Only the service's own top-level
// fields count — nested blocks (endpoints, event triggers) repeat `state =`
// one tab deeper.
export function parseLaunchctlPrint(text: string): LaunchdJob | null {
  const state = /^\tstate = (.+)$/m.exec(text)?.[1]
  const runs = /^\truns = (\d+)$/m.exec(text)?.[1]
  if (!state || runs === undefined) return null
  const interval = /^\trun interval = (\d+) seconds$/m.exec(text)?.[1]
  return {
    running: state.trim() === 'running',
    runs: Number(runs),
    intervalSeconds: interval ? Number(interval) : null,
  }
}

export function graceMs(job: LaunchdJob): number {
  return Math.max(MIN_GRACE_MS, 3 * (job.intervalSeconds ?? 60) * 1000)
}

// Whether a job has gone quiet for long enough that launchd is not going to
// start it. A changed run count (up, or reset by a reinstall) or a running job
// is life. After a kick the clock restarts, so a job that still does not run
// is retried once per grace period rather than every tick.
export function assess(previous: WatchState | undefined, job: LaunchdJob, now: number): { next: WatchState, kick: boolean } {
  if (!previous || job.running || job.runs !== previous.runs) {
    return { next: { runs: job.runs, aliveAt: now }, kick: false }
  }
  if (now - previous.aliveAt < graceMs(job)) return { next: previous, kick: false }
  return { next: { runs: job.runs, aliveAt: now }, kick: true }
}

export function watchdogLabels(value: string | undefined): string[] {
  return (value || '').split(',').map((label) => label.trim())
    .filter((label) => /^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/.test(label))
}

function launchctl(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/bin/launchctl', args, { timeout: LAUNCHCTL_TIMEOUT_MS, encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

export interface LaunchdWatchdogOptions {
  labels: string[]
  domain?: string
  run?: (args: string[]) => Promise<string>
  now?: () => number
  log?: (message: string) => void
}

// One pass over every watched job. Exposed for tests; production calls it from
// the interval timer started below.
export function createLaunchdWatchdog(options: LaunchdWatchdogOptions): () => Promise<void> {
  const domain = options.domain || `gui/${process.getuid?.() ?? 0}`
  const run = options.run || launchctl
  const now = options.now || Date.now
  const log = options.log || ((message: string) => console.warn(message))
  const watched = new Map<string, WatchState>()
  return async () => {
    for (const label of options.labels) {
      let job: LaunchdJob | null
      try {
        job = parseLaunchctlPrint(await run(['print', `${domain}/${label}`]))
      } catch {
        // Not loaded (an install in progress, or a job this machine does not
        // have). Forget it so a reload starts from a fresh baseline.
        watched.delete(label)
        continue
      }
      if (!job) continue
      const { next, kick } = assess(watched.get(label), job, now())
      watched.set(label, next)
      if (!kick) continue
      const every = job.intervalSeconds ? `every ${job.intervalSeconds}s` : 'on a timer'
      log(`[launchd-watchdog] ${label} runs ${every} but has not run for ${Math.round(graceMs(job) / 60_000)}m; `
        + 'launchd is not starting it (session in on-demand-only mode?) — starting it directly')
      try {
        await run(['kickstart', `${domain}/${label}`])
      } catch (error) {
        log(`[launchd-watchdog] could not start ${label}: ${(error as Error).message}`)
      }
    }
  }
}

export function startLaunchdWatchdog(env: NodeJS.ProcessEnv = process.env): (() => void) | null {
  if (process.platform !== 'darwin') return null
  const labels = watchdogLabels(env.POISE_LAUNCHD_WATCHDOG)
  if (labels.length === 0) return null
  const pass = createLaunchdWatchdog({ labels })
  let busy = false
  const tick = () => {
    if (busy) return
    busy = true
    void pass().finally(() => { busy = false })
  }
  tick()
  const timer = setInterval(tick, TICK_MS)
  timer.unref()
  return () => clearInterval(timer)
}
