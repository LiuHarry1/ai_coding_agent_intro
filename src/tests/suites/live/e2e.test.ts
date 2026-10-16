import { defineScriptSuite } from '../../lib/script-suite.js'

/**
 * Opt-in: `npm run test:e2e`.
 *
 * Drives the real web UI against a running agent and spends model tokens.
 * Start `npm start` and `npm run dev:web` first and set
 * `RUN_CODING_TOOLS_E2E=1`; without it the script exits early as a no-op.
 */
defineScriptSuite('e2e', ['test-coding-tools-ui-e2e.ts'], {
  timeoutMs: 600_000,
})
