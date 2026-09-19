// Cooperative handover barrier for process-owned background operations.
// Pausing stops admission, never cancels an operation already in progress.
let paused = false
let operations = 0

export function pauseReleaseBackground(): void { paused = true }
export function resumeReleaseBackground(): void { paused = false }
export function releaseBackgroundPaused(): boolean { return paused }
export function releaseBackgroundBusy(): number { return operations }

export function trackReleaseBackground(): () => void {
  operations += 1
  let finished = false
  return () => {
    if (finished) return
    finished = true
    operations -= 1
  }
}
