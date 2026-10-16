import { defineScriptSuite } from '../../lib/script-suite.js'

/**
 * Opt-in: `npm run test:browser`.
 *
 * Launches a real Chrome (throwaway profile, never the agent's own) and
 * exercises the isolated backend, the Playwright engine, the extension relay
 * and the real MV3 extension. Needs Chrome installed and a free port for the
 * relay; takes minutes, not seconds.
 */
defineScriptSuite(
  'browser/live',
  [
    'test-browser-live.ts',
    'test-browser-playwright.ts',
    'test-browser-relay.ts',
    'test-extension-e2e.ts',
  ],
  { timeoutMs: 600_000 },
)
