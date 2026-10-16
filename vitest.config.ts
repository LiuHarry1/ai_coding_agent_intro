import { defineConfig } from 'vitest/config'

const isCI = !!process.env.CI

export default defineConfig({
  test: {
    reporters: isCI ? ['default', 'github-actions'] : ['default'],
    projects: [
      {
        // Native vitest tests (`*.test.ts` / `*.test.js`). Fast, isolated,
        // run in parallel. New tests go here.
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'web/src/**/*.test.js'],
          exclude: ['src/tests/**', '**/node_modules/**'],
        },
      },
      {
        // Legacy `src/tests/test-*.ts` scripts, each run as a child process
        // by `src/tests/suites/*.test.ts`. Scripts share ports, temp
        // workspaces and ~/.ai-agent state, so suites run one at a time.
        // Suites that need Chrome / a running server / model tokens live in
        // `suites/live/` and are only reachable via `vitest.live.config.ts`.
        test: {
          name: 'scripts',
          include: ['src/tests/suites/*.test.ts'],
          fileParallelism: false,
          sequence: { concurrent: false },
          testTimeout: 300_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
})
