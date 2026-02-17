import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/e2e/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Run test files sequentially since each starts a server
    fileParallelism: false
  }
})
