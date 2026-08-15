/**
 * Smoke test: Grep dual-channel mapper + API projection.
 * Run: npx tsx src/scripts/test-dual-channel-grep.ts
 */
import assert from 'node:assert/strict'
import { definition as grepDef, type GrepOutput } from '../tools/GrepTool/GrepTool.js'
import { buildToolMessage } from '../services/tools/tool_execution.js'
import { projectMessagesForApi } from '../core/agent/messageSanitize.js'
import type { Message, ToolResultContentBlockParam } from '../core/types.js'
import { toolResultBlocksToText } from '../utils/tool-result-content.js'

function mappedText(
  content: string | ToolResultContentBlockParam[],
): string {
  return typeof content === 'string' ? content : toolResultBlocksToText(content)
}

function testMapperFiles() {
  const data: GrepOutput = {
    mode: 'files_with_matches',
    numFiles: 2,
    filenames: ['a.ts', 'b.ts'],
    files: [
      { path: 'a.ts', matchCount: 3 },
      { path: 'b.ts', matchCount: 1 },
    ],
  }
  const mapped = grepDef.mapToolResultToToolResultBlockParam!(data, 't1')
  assert.equal(mapped.type, 'tool_result')
  assert.equal(mapped.tool_use_id, 't1')
  assert.equal(mapped.content, 'Found 2 files\na.ts\nb.ts')
  console.log('ok mapper files_with_matches')
}

function testMapperEmpty() {
  const data: GrepOutput = {
    mode: 'files_with_matches',
    numFiles: 0,
    filenames: [],
    files: [],
  }
  const mapped = grepDef.mapToolResultToToolResultBlockParam!(data, 't2')
  assert.equal(mapped.content, 'No files found')
  console.log('ok mapper empty')
}

function testMapperCount() {
  const data: GrepOutput = {
    mode: 'count',
    numFiles: 2,
    filenames: ['a.ts', 'b.ts'],
    files: [
      { path: 'a.ts', matchCount: 3 },
      { path: 'b.ts', matchCount: 1 },
    ],
    content: 'a.ts:3\nb.ts:1',
    numMatches: 4,
  }
  const mapped = grepDef.mapToolResultToToolResultBlockParam!(data, 't3')
  assert.ok(mappedText(mapped.content).includes('a.ts:3'))
  assert.ok(
    mappedText(mapped.content).includes(
      'Found 4 total occurrences across 2 files.',
    ),
  )
  console.log('ok mapper count')
}

function testBuildAndProject() {
  const data: GrepOutput = {
    mode: 'files_with_matches',
    numFiles: 1,
    filenames: ['x.ts'],
    files: [{ path: 'x.ts', matchCount: 2 }],
  }
  const mapped = grepDef.mapToolResultToToolResultBlockParam!(data, 'id1')
  const toolMsg = buildToolMessage([
    {
      toolCallId: 'id1',
      toolName: 'Grep',
      result: mappedText(mapped.content),
      toolUseResult: data,
    },
  ])
  assert.equal(toolMsg.content[0]!.toolUseResult, data)

  const projected = projectMessagesForApi([toolMsg as Message])
  const part = (projected[0] as { content: Array<{ toolUseResult?: unknown }> })
    .content[0]!
  assert.equal(part.toolUseResult, undefined)
  console.log('ok buildToolMessage + projectMessagesForApi')
}

function testOutputSchema() {
  const ok = grepDef.outputSchema!.safeParse({
    mode: 'files_with_matches',
    numFiles: 1,
    filenames: ['a.ts'],
    files: [{ path: 'a.ts', matchCount: 1 }],
  })
  assert.equal(ok.success, true)
  const bad = grepDef.outputSchema!.safeParse({ mode: 'nope' })
  assert.equal(bad.success, false)
  console.log('ok outputSchema')
}

testMapperFiles()
testMapperEmpty()
testMapperCount()
testBuildAndProject()
testOutputSchema()
console.log('all dual-channel grep tests passed')
