import { defineConfig } from 'vitest/config'

/**
 * Opt-in suites that need things CI does not have: a real Chrome, a running
 * agent + web UI, model tokens. They are deliberately kept out of
 * `vitest.config.ts` so `npm test` never picks them up; run one explicitly:
 *
 *   npm run test:browser   → project "browser"
 *   npm run test:e2e       → project "e2e"
 *
 * Each suite file under `src/tests/suites/live/` documents its own
 * prerequisites.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'browser',
          include: ['src/tests/suites/live/browser.test.ts'],
          fileParallelism: false,
          sequence: { concurrent: false },
          testTimeout: 660_000,
          hookTimeout: 60_000,
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['src/tests/suites/live/e2e.test.ts'],
          fileParallelism: false,
          sequence: { concurrent: false },
          testTimeout: 660_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
})
