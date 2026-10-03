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

// `launchctl print` exits 113 ("Could not find service") when the job is not
// loaded in the domain. Any other failure — a timeout, a busy launchd — says
// nothing about the job itself.
const NOT_LOADED_EXIT = 113

export function isNotLoaded(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === NOT_LOADED_EXIT
}

function failure(error: unknown): string {
  const e = error as { killed?: boolean, signal?: string | null, code?: unknown, message?: string } | null
  if (e?.killed || e?.signal) return `launchctl timed out after ${LAUNCHCTL_TIMEOUT_MS / 1000}s`
  if (typeof e?.code === 'number') return `launchctl exited ${e.code}`
  return (e?.message || String(error)).split('\n')[0]
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
  // A job that cannot be read is reported once, and again only if the reason
  // changes — the same line every minute would bury the log.
  const reported = new Map<string, string>()
  const report = (label: string, problem: string) => {
    if (reported.get(label) === problem) return
    reported.set(label, problem)
    log(`[launchd-watchdog] ${label}: ${problem}`)
  }
  return async () => {
    for (const label of options.labels) {
      let text: string
      try {
        text = await run(['print', `${domain}/${label}`])
      } catch (error) {
        if (isNotLoaded(error)) {
          // An install in progress, or a job this machine does not have.
          // Forget it so a reload starts from a fresh baseline.
          watched.delete(label)
          reported.delete(label)
        } else {
          // Keep the baseline: resetting it on a hiccup would push a stall
          // that is already under way back by a whole grace period.
          report(label, `could not read its launchd state (${failure(error)}); still watching`)
        }
        continue
      }
      const job = parseLaunchctlPrint(text)
      if (!job) {
        report(label, 'launchctl print output was not understood; this job is not watched until it is')
        continue
      }
      reported.delete(label)
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
