import { defineScriptSuite } from '../lib/script-suite.js'

defineScriptSuite('server', [
  'test-chat-attachments.ts',
  'test-session-artifact-auth.ts',
])
