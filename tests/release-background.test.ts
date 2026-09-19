import { afterEach, expect, it } from 'vitest'
import { pauseReleaseBackground, resumeReleaseBackground, releaseBackgroundPaused, releaseBackgroundBusy, trackReleaseBackground } from '../server/release-background'

afterEach(() => resumeReleaseBackground())

it('pauses admission without cancelling already admitted background work', () => {
  const finish = trackReleaseBackground()
  expect(releaseBackgroundBusy()).toBe(1)
  pauseReleaseBackground()
  expect(releaseBackgroundPaused()).toBe(true)
  expect(releaseBackgroundBusy()).toBe(1)
  finish()
  expect(releaseBackgroundBusy()).toBe(0)
  finish()
  expect(releaseBackgroundBusy()).toBe(0)
  resumeReleaseBackground()
  expect(releaseBackgroundPaused()).toBe(false)
})
