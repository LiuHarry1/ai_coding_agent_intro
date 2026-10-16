import { defineScriptSuite } from '../lib/script-suite.js'

defineScriptSuite('settings', [
  'test-settings-validation.ts',
  'test-managed-settings.ts',
  'test-cron.ts',
  'test-echarts-chart.ts',
])
