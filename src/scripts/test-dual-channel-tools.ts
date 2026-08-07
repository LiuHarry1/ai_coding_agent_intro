/**
 * Dual-channel gate: built-in tools have mapper + outputSchema;
 * Edit/Write mode B (ACK ≠ before/after); Bash mode C schema.
 *
 * Run: npx tsx src/scripts/test-dual-channel-tools.ts
 */
import assert from 'node:assert/strict'
import '../tools.js'
import { defaultRegistry } from '../core/tool-registry.js'
import {
  definition as editDef,
  type EditFileOutput,
} from '../tools/FileEditTool/FileEditTool.js'
import {
  definition as writeDef,
  type WriteFileOutput,
} from '../tools/FileWriteTool/FileWriteTool.js'
import { ShellToolOutputSchema } from '../tools/shell-runner.js'
import { buildToolMessage } from '../services/tools/tool_execution.js'
import { projectMessagesForApi } from '../core/agent/messageSanitize.js'
import type { Message } from '../core/types.js'

function testRegistryGate() {
  const missing: string[] = []
  for (const { name } of defaultRegistry.list()) {
    const def = defaultRegistry.get(name)!
    if (!def.mapToolResultToToolResultBlockParam) {
      missing.push(`${name}: missing mapper`)
    }
    if (!def.outputSchema) {
      missing.push(`${name}: missing outputSchema`)
    }
  }
  assert.equal(missing.length, 0, missing.join('\n'))
  assert.equal(
    defaultRegistry.get('PublishPreview'),
    undefined,
    'PublishPreview must be removed',
  )
  console.log('ok registry dual-channel gate', defaultRegistry.list().length)
}

function testEditModeB() {
  const data: EditFileOutput = {
    type: 'update',
    filePath: 'a.ts',
    oldString: 'foo',
    newString: 'bar',
    replacements: 1,
    message: 'Edited a.ts (1 replacement)',
    beforeContent: 'const x = foo\n',
    afterContent: 'const x = bar\n',
  }
  const mapped = editDef.mapToolResultToToolResultBlockParam!(data, 't1')
  assert.equal(mapped.content, data.message)
  assert.ok(!String(mapped.content).includes('const x'))
  const parsed = editDef.outputSchema!.safeParse(data)
  assert.ok(parsed.success)

  const msg = buildToolMessage([
    {
      toolCallId: 't1',
      toolName: 'Edit',
      result: data.message,
      toolUseResult: data,
    },
  ])
  const projected = projectMessagesForApi([msg as Message])
  const content = (projected[0] as { content?: unknown[] })?.content?.[0] as {
    toolUseResult?: unknown
  }
  assert.equal(content?.toolUseResult, undefined)
  console.log('ok Edit mode B + sanitize')
}

function testWriteModeB() {
  const data: WriteFileOutput = {
    type: 'create',
    filePath: 'b.ts',
    content: 'hello\nworld\n',
    numLines: 2,
    numChars: 12,
    message: 'Wrote b.ts (2 lines, 12 chars)',
  }
  const mapped = writeDef.mapToolResultToToolResultBlockParam!(data, 't2')
  assert.equal(mapped.content, data.message)
  assert.ok(!String(mapped.content).includes('hello'))
  assert.ok(writeDef.outputSchema!.safeParse(data).success)
  console.log('ok Write mode B')
}

function testShellSchema() {
  const ok = ShellToolOutputSchema.safeParse({
    text: 'hi\n<stderr>\ne\n</stderr>',
    stdout: 'hi\n',
    stderr: 'e\n',
    exitCode: 1,
  })
  assert.ok(ok.success)
  console.log('ok Shell outputSchema')
}

testRegistryGate()
testEditModeB()
testWriteModeB()
testShellSchema()
console.log('all dual-channel tests passed')
