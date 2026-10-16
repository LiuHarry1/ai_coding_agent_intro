import { defineScriptSuite } from '../lib/script-suite.js'

defineScriptSuite('read', [
  'test-read-boundary-reminders.ts',
  'test-read-gates-and-path-suggest.ts',
  'test-read-raw-out-map.ts',
  'test-dual-channel-grep.ts',
  'test-remote-grep-shell.ts',
  'test-image-tool-result.ts',
])
