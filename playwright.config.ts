import { defineConfig, devices } from '@playwright/test'

const port = 5566
const baseURL = `http://127.0.0.1:${port}`

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
      POISE_DB: 'test-results/e2e/cache.db',
      POISE_PORT: String(port),
      POISE_EDITOR_DIR: 'test-results/e2e/editor',
      POISE_CHAT_ATTACHMENTS_DIR: 'test-results/e2e/chat-attachments',
      POISE_ESPANSO_MATCH_DIR: 'test-results/e2e/espanso-match',
      AGENT_INTERFACE_ROOT: 'test-results/e2e/agent-interface',
      TMPDIR: 'test-results/e2e/tmp',
    },
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
