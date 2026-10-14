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
          include: ['src/**/*.test.ts', 'client/web/src/**/*.test.js'],
          exclude: ['src/scripts/**', '**/node_modules/**'],
        },
      },
      {
        // Legacy `src/scripts/test-*.ts` scripts, each run as a child process
        // by `src/scripts/suites/*.test.ts`. Scripts share ports, temp
        // workspaces and ~/.ai-agent state, so suites run one at a time.
        test: {
          name: 'scripts',
          include: ['src/scripts/suites/*.test.ts'],
          fileParallelism: false,
          sequence: { concurrent: false },
          testTimeout: 300_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
})
