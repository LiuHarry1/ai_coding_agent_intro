/**
 * Smoke test: image blocks inside tool_result (CC parity).
 * Run: npx tsx src/scripts/test-image-tool-result.ts
 */
import assert from 'node:assert/strict'
import { tool } from 'ai'
import { z } from 'zod'
import {
  buildToolMessage,
  runToolCalls,
  type ExecutedToolResult,
} from '../services/tools/tool_execution.js'
import type {
  ImagePart,
  Message,
  ToolContext,
  ToolDefinition,
  ToolResultPart,
  UserMessage,
} from '../core/types.js'
import type { IProvider } from '../core/llm/types.js'
import { buildImageBlock } from '../utils/tool-result-content.js'
import { toolResultImageBlockFromBuffer } from '../utils/image/resize-buffer.js'
import { estimateMessageTokens } from '../services/compact/tokens.js'
import { projectMessagesForApi } from '../core/agent/messageSanitize.js'

/** 1x1 transparent PNG. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

function makeScreenshotDef(isError: boolean): ToolDefinition {
  return {
    name: 'Screenshot',
    description: 'test screenshot tool',
    mapToolResultToToolResultBlockParam(output, toolUseID) {
      const o = output as { note: string }
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: [
          { type: 'text', text: o.note },
          buildImageBlock(PNG_BASE64, 'image/png'),
        ],
        ...(isError ? { is_error: true } : {}),
      }
    },
    create() {
      return tool({
        description: 'test screenshot tool',
        inputSchema: z.object({}),
        execute: async () => ({ data: { note: 'shot taken' } }),
      })
    },
  }
}

async function execute(def: ToolDefinition): Promise<ExecutedToolResult[]> {
  return runToolCalls({
    toolCalls: [{ toolCallId: 'c1', toolName: 'Screenshot', input: {} }],
    tools: { Screenshot: def.create('/tmp', {} as unknown as ToolContext) },
    wire: { toolResult: () => {} } as never,
    concurrencyPolicy: () => false,
    getDefinition: name => (name === 'Screenshot' ? def : undefined),
  })
}

async function testImageResultReachesModel() {
  const results = await execute(makeScreenshotDef(false))
  const [result] = results
  assert.ok(result)
  assert.equal(result.result, 'shot taken\n[image]')
  assert.equal(result.resultBlocks?.length, 2)

  const msg = buildToolMessage(results)
  const output = msg.content[0]!.output
  assert.equal(output.type, 'content')
  assert.deepEqual(output.type === 'content' ? output.value : [], [
    { type: 'text', text: 'shot taken' },
    { type: 'image-data', data: PNG_BASE64, mediaType: 'image/png' },
  ])
  console.log('ok image blocks reach the model as content output')
}

async function testErrorResultDropsImage() {
  const results = await execute(makeScreenshotDef(true))
  const [result] = results
  assert.ok(result)
  assert.equal(result.isError, true)
  assert.equal(result.resultBlocks, undefined)
  assert.equal(result.result, 'shot taken')

  const msg = buildToolMessage(results)
  assert.equal(msg.content[0]!.output.type, 'text')
  console.log('ok is_error results are text-only')
}

async function testTokenEstimateSkipsBase64() {
  const results = await execute(makeScreenshotDef(false))
  const tokens = estimateMessageTokens(buildToolMessage(results))
  // Flat per-image cost, not ceil(base64.length / 4).
  assert.ok(tokens > 1000 && tokens < 2000, `unexpected estimate: ${tokens}`)
  console.log('ok token estimation uses flat image cost')
}

async function testResizePipeline() {
  const block = await toolResultImageBlockFromBuffer(
    Buffer.from(PNG_BASE64, 'base64'),
    'image/png',
  )
  assert.equal(block.type, 'image')
  assert.equal(block.source.type, 'base64')
  assert.ok(block.source.data.length > 0)
  console.log(`ok resize pipeline (${block.source.media_type})`)
}

function fakeProvider(supportsContentBlocks: boolean): IProvider {
  return {
    chatModel: () => ({}) as never,
    streamTextExtras: () => ({}),
    defaultModelId: () => 'test',
    describe: () => 'test',
    supportsToolResultContentBlocks: () => supportsContentBlocks,
  }
}

async function projectedMessages(provider: IProvider): Promise<Message[]> {
  const results = await execute(makeScreenshotDef(false))
  return projectMessagesForApi([buildToolMessage(results) as Message], provider)
}

async function testMultimodalProviderKeepsBlocks() {
  const projected = await projectedMessages(fakeProvider(true))
  assert.equal(projected.length, 1)
  const part = (projected[0] as { content: ToolResultPart[] }).content[0]!
  assert.equal(part.output.type, 'content')
  console.log('ok multimodal provider keeps content blocks')
}

async function testChatCompletionsProviderRelocatesImage() {
  const projected = await projectedMessages(fakeProvider(false))
  assert.equal(projected.length, 2)

  const part = (projected[0] as { content: ToolResultPart[] }).content[0]!
  assert.equal(part.output.type, 'text')
  assert.equal(
    part.output.type === 'text' ? part.output.value : '',
    'shot taken\n[image]',
  )

  const relocated = projected[1] as UserMessage
  assert.equal(relocated.role, 'user')
  assert.equal(relocated.isMeta, true)
  const image = (relocated.content as ImagePart[]).find(
    p => p.type === 'image',
  )
  assert.ok(image, 'expected a relocated image part')
  assert.equal(image.mediaType, 'image/png')
  assert.ok(Buffer.isBuffer(image.image))
  console.log('ok chat-completions provider relocates image to user message')
}

async function main() {
  await testImageResultReachesModel()
  await testErrorResultDropsImage()
  await testTokenEstimateSkipsBase64()
  await testResizePipeline()
  await testMultimodalProviderKeepsBlocks()
  await testChatCompletionsProviderRelocatesImage()
  console.log('\nall image tool_result tests passed')
}

void main().catch(err => {
  console.error(err)
  process.exit(1)
})
