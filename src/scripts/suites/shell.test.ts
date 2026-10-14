import { defineScriptSuite } from '../lib/script-suite.js'

defineScriptSuite('shell', [
  'test-bash-tasks.ts',
  'test-shell-file-fd.ts',
  'test-windows-git-bash-path.ts',
  'test-filesystem-permissions.ts',
  'test-resolve-path.ts',
])
