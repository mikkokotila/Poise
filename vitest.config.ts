import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['tests/snippet-isolation.ts'],
    include: ['tests/**/*.test.{ts,mjs}'],
    clearMocks: true,
    restoreMocks: true,
    testTimeout: 10_000,
  },
})
