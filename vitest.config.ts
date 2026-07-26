import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,mjs}'],
    clearMocks: true,
    restoreMocks: true,
    testTimeout: 10_000,
  },
})
