import { defineScriptSuite } from '../lib/script-suite.js'

defineScriptSuite('worker', [
  'test-worker-in-workspace.ts',
  'test-worker-launch.ts',
])
