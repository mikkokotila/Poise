import { defineConfig, devices } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const port = 5566
const baseURL = `http://127.0.0.1:${port}`
const e2eRoot = resolve('test-results/e2e')
const callerRelease = JSON.parse(
  readFileSync(new URL('./config/caller-release.json', import.meta.url), 'utf8'),
) as { commit: string }
const callerReleaseRoot = resolve(e2eRoot, 'caller-release')

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: 'test-results/playwright',
  snapshotPathTemplate: '{testDir}/{testFilePath}-snapshots/{arg}{-projectName}{ext}',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : 'list',
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      maxDiffPixelRatio: 0.03,
    },
  },
  use: {
    baseURL,
    viewport: { width: 1280, height: 720 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run preview',
    env: {
      POISE_DB: resolve(e2eRoot, 'cache.db'),
      POISE_PORT: String(port),
      POISE_EDITOR_DIR: resolve(e2eRoot, 'editor'),
      POISE_CHAT_ATTACHMENTS_DIR: resolve(e2eRoot, 'chat-attachments'),
      POISE_ESPANSO_MATCH_DIR: resolve(e2eRoot, 'espanso-match'),
      POISE_ENFORCE_CALLER_RELEASE: '1',
      CALLER_RELEASE_SHA: callerRelease.commit,
      CALLER_RELEASE_ROOT: callerReleaseRoot,
      CALLER_BIN_ROOT: resolve(callerReleaseRoot, 'venv/bin'),
      AGENT_INTERFACE_ROOT: resolve(callerReleaseRoot, 'source/agent_interface'),
      TMPDIR: resolve(e2eRoot, 'tmp'),
    },
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
