import { defineScriptSuite } from '../lib/script-suite.js'

defineScriptSuite('agents', [
  'test-agent-picker.ts',
  'test-agent-hot-reload.ts',
  'test-plugin-loading.ts',
  'test-primary-agent-parse.ts',
  'test-tool-glob.ts',
])
