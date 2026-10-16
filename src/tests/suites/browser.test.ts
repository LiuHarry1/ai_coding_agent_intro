import { defineScriptSuite } from '../lib/script-suite.js'

// Browser-stack checks that need no Chrome. The suites that launch a real
// browser live under `suites/live/` and run via `npm run test:browser`.
defineScriptSuite('browser', [
  'test-browser-unit.ts',
  'test-browser-enablement.ts',
  'test-browser-boundary.ts',
])
