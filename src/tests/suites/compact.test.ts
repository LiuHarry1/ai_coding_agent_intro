import { defineScriptSuite } from '../lib/script-suite.js'

defineScriptSuite('compact', [
  'test-compact-boundary.ts',
  'test-full-compact-cache-safe.ts',
  'test-micro-reactive-compact.ts',
  'test-compact-outcome.ts',
  'test-session-compact-persistence.ts',
  'test-compaction-agent-listing.ts',
  'test-read-file-state-dedup.ts',
  'test-fork-read-isolation.ts',
])
