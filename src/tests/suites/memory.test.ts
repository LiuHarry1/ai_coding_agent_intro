import { defineScriptSuite } from '../lib/script-suite.js'

defineScriptSuite('memory', [
  'test-auto-memory.ts',
  'test-memory-prefetch.ts',
  'test-session-memory.ts',
  'test-memory-lifecycle.ts',
  'test-request-scope.ts',
  'test-memory-deployment.mjs',
  'test-rules-loader.ts',
  'test-managed-extensions.ts',
  'test-agent-memory.ts',
  'test-memory-binding.ts',
])
