import assert from 'node:assert/strict'
import '../tools.js'
import { defaultRegistry } from '../core/tool-registry.js'
import { isDeferredTool } from '../core/tool-enablement.js'
import { BROWSER_TOOL_NAMES } from '../constants/tool_names.js'
import { definition as enterPlanMode } from '../tools/EnterPlanModeTool/EnterPlanModeTool.js'
import { definition as exitPlanMode } from '../tools/ExitPlanModeTool/ExitPlanModeTool.js'
import { createToolSearchDefinition } from '../tools/ToolSearchTool/ToolSearchTool.js'
import { CODING_TOOL_MANIFEST } from './coding-tools-manifest.js'

const names = CODING_TOOL_MANIFEST.map(entry => entry.name)
assert.equal(new Set(names).size, names.length, 'manifest tool names must be unique')

for (const excluded of BROWSER_TOOL_NAMES) {
  assert.ok(!names.includes(excluded), `${excluded} is explicitly out of scope`)
}

for (const entry of CODING_TOOL_MANIFEST) {
  if (entry.registration !== 'registry') continue

  const definition = defaultRegistry.get(entry.name)
  if (entry.platform && process.platform !== entry.platform) {
    assert.equal(definition, undefined, `${entry.name} must be platform gated`)
    continue
  }

  assert.ok(definition, `${entry.name} must be registered`)
  assert.ok(definition.outputSchema, `${entry.name} must expose outputSchema`)
  assert.ok(
    definition.mapToolResultToToolResultBlockParam,
    `${entry.name} must expose a dual-channel mapper`,
  )
  assert.equal(
    isDeferredTool(definition),
    entry.deferred === true,
    `${entry.name} deferred flag must match the manifest`,
  )
}

const modeDefinitions = new Map(
  [enterPlanMode, exitPlanMode].map(definition => [
    definition.name,
    definition,
  ]),
)
for (const entry of CODING_TOOL_MANIFEST.filter(
  item => item.registration === 'mode',
)) {
  const definition = modeDefinitions.get(entry.name)
  assert.ok(definition, `${entry.name} mode definition must exist`)
  assert.ok(definition.outputSchema, `${entry.name} must expose outputSchema`)
  assert.ok(
    definition.mapToolResultToToolResultBlockParam,
    `${entry.name} must expose a mapper`,
  )
}

const toolSearch = createToolSearchDefinition([
  { name: 'DeferredFixture', description: 'fixture', isMcp: false },
])
assert.equal(toolSearch.name, 'ToolSearch')
assert.ok(toolSearch.outputSchema)
assert.ok(toolSearch.mapToolResultToToolResultBlockParam)

assert.deepEqual(
  CODING_TOOL_MANIFEST.reduce<Record<string, number>>((counts, entry) => {
    counts[entry.category] = (counts[entry.category] ?? 0) + 1
    return counts
  }, {}),
  { filesystem: 6, shell: 4, research: 2, workflow: 10 },
)

console.log(`ok coding-tool manifest (${CODING_TOOL_MANIFEST.length} tools)`)

