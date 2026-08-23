/**
 * Smoke: Grep execute → executeOneTool → wire carries tool_use_result.
 * Run: npx tsx src/scripts/test-grep-wire.ts
 */
import assert from 'node:assert/strict'
import { definition as grepDef } from '../tools/GrepTool/GrepTool.js'
import '../tools.js'
import { defaultRegistry } from '../core/tool-registry.js'
import { executeOneTool } from '../services/tools/tool_execution.js'
import type { WireEmitter } from '../core/wire-emitter.js'

const def = defaultRegistry.get('Grep')
assert.ok(def?.mapToolResultToToolResultBlockParam, 'Grep mapper registered')

const cwd = process.cwd()
const tools = {
  Grep: grepDef.create(cwd, {
    wire: {
      toolResult() {},
      processOutput() {},
    },
  } as never),
}

const emitted: Array<Record<string, unknown>> = []
const wire = {
  toolResult(m: Record<string, unknown>) {
    emitted.push(m)
  },
  processOutput() {},
} as unknown as WireEmitter

const result = await executeOneTool(
  {
    toolCallId: 't1',
    toolName: 'Grep',
    input: {
      pattern: 'toolUseResult',
      glob: '**/GrepCard.jsx',
      output_mode: 'files_with_matches',
    },
  },
  tools,
  wire,
)

assert.ok(result?.toolUseResult, 'executed toolUseResult set')
assert.ok(emitted[0]?.tool_use_result, 'wire tool_use_result set')
const tur = emitted[0]!.tool_use_result as { mode?: string; files?: unknown[] }
assert.equal(tur.mode, 'files_with_matches')
assert.ok(Array.isArray(tur.files))
console.log('ok grep wire tool_use_result', {
  files: tur.files?.length,
  resultPreview: String(result?.result).slice(0, 80),
})
