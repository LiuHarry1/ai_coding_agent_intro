import {
  CODING_TOOLS_ENV,
  CODING_TOOLS_INTEGRATION,
  CODING_TOOLS_UNIT,
} from '../coding-tools-suites.js'
import { defineScriptSuite } from '../lib/script-suite.js'

defineScriptSuite('tools/unit', CODING_TOOLS_UNIT, { env: CODING_TOOLS_ENV })
defineScriptSuite('tools/integration', CODING_TOOLS_INTEGRATION, {
  env: CODING_TOOLS_ENV,
})
