/**
 * Micro projection lifetime and reactive tail-preserving compact tests.
 * Run: npx tsx src/scripts/test-micro-reactive-compact.ts
 */
import assert from 'node:assert/strict'
import type { LanguageModel } from 'ai'
import type { AnyTool, IProvider, Message, RunAgentFn } from '../core/types.js'
import { isRoleMessage } from '../core/types.js'
import {
  createCompactBoundaryMessage,
  getMessagesAfterCompactBoundary,
} from '../core/messages/compact-boundary.js'
import {
  applyMicroCompactProjection,
  compactConversation,
  getActiveModelMessages,
  microCompact,
  rebaseMicroCompactState,
  resetMicroCompactState,
} from '../services/compact/index.js'
import { BASH_TOOL_NAME } from '../constants/tool_names.js'
import { createSession, deleteSession } from '../session/index.js'
import { shouldAttemptReactiveCompaction } from '../core/query/run-step.js'
import { maxTokensOverrideFromError } from '../core/query/helpers.js'

function toolOutput(
  messages: Message[],
  toolCallId: string,
): string | undefined {
  for (const message of messages) {
    if (!isRoleMessage(message) || message.role !== 'tool') continue
    const part = message.content.find(item => item.toolCallId === toolCallId)
    if (part?.output.type === 'text') return part.output.value
  }
  return undefined
}

function provider(): IProvider {
  return {
    chatModel: () => ({}) as LanguageModel,
    streamTextExtras: () => ({}),
    defaultModelId: () => 'test-model',
    describe: () => 'test',
  }
}

async function testMicroProjectionLifetime(): Promise<void> {
  const sessionId = createSession({ cwd: process.cwd() }).id
  const originalOutput = 'x'.repeat(3_000)
  const history: Message[] = [
    { role: 'user', content: 'run it', uuid: 'u1' },
    {
      role: 'assistant',
      uuid: 'a1',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: BASH_TOOL_NAME,
          input: { command: 'echo test' },
        },
      ],
    },
    {
      role: 'tool',
      uuid: 't1',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: BASH_TOOL_NAME,
          output: { type: 'text', value: originalOutput },
        },
      ],
    },
  ]

  try {
    const compacted = microCompact(history, 0, sessionId)
    assert.equal(toolOutput(history, 'call-1'), originalOutput)
    assert.notEqual(toolOutput(compacted.messages, 'call-1'), originalOutput)

    const nextStep = [
      ...history,
      { role: 'user' as const, content: 'continue', uuid: 'u2' },
    ]
    const projected = applyMicroCompactProjection(nextStep, sessionId)
    assert.notEqual(toolOutput(projected, 'call-1'), originalOutput)
    assert.equal(toolOutput(nextStep, 'call-1'), originalOutput)

    const boundary = createCompactBoundaryMessage('auto', 10, 'u2')
    const afterBoundary = applyMicroCompactProjection(
      [...nextStep, boundary],
      sessionId,
    )
    assert.equal(toolOutput(afterBoundary, 'call-1'), originalOutput)
  } finally {
    resetMicroCompactState(sessionId)
    deleteSession(sessionId)
  }
}

async function testReactiveTailPreservesToolPair(): Promise<void> {
  const messages: Message[] = [
    { role: 'user', content: 'old request', uuid: 'old-u' },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'old response' }],
      uuid: 'old-a',
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'tail-call',
          toolName: BASH_TOOL_NAME,
          input: { command: 'large output' },
        },
      ],
      uuid: 'tail-call-message',
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'tail-call',
          toolName: BASH_TOOL_NAME,
          output: { type: 'text', value: 'z'.repeat(39_000) },
        },
      ],
      uuid: 'tail-result-message',
    },
    ...Array.from({ length: 5 }, (_, index): Message => ({
      role: 'user',
      content: `recent-${index}-${'r'.repeat(1_000)}`,
      uuid: `recent-${index}`,
    })),
  ]
  let summarizedUuids: string[] = []
  const runAgent: RunAgentFn = async (_prompt, options) => {
    summarizedUuids = (options.messages ?? []).map(
      message => message.uuid ?? '',
    )
    return '<summary>reactive summary</summary>'
  }
  const tools = { Bash: {} as AnyTool }
  const testProvider = provider()
  const result = await compactConversation(messages, 'test-model', {
    cwd: process.cwd(),
    todos: [],
    fileRestore: { maxFiles: 0, maxTokensPerFile: 0, totalBudget: 0 },
    provider: testProvider,
    runAgent,
    cacheSafeParams: {
      systemPrompt: 'test',
      tools,
      provider: testProvider,
      model: 'test-model',
      forkContextMessages: messages,
    },
    preserveRecentTail: {
      minTokens: 10_000,
      maxTokens: 40_000,
      minTextMessages: 5,
    },
  })

  assert.ok(result)
  assert.deepEqual(summarizedUuids, ['old-u', 'old-a'])
  assert.equal(result.messagesToKeep[0]?.uuid, 'tail-call-message')
  assert.equal(result.messagesToKeep[1]?.uuid, 'tail-result-message')
  assert.ok(result.messagesToKeep.some(message => message.uuid === 'recent-4'))
  assert.equal(
    result.appendMessages.some(message => message.uuid === 'tail-call-message'),
    false,
  )
  const boundary = result.appendMessages[0]
  assert.ok('compactMetadata' in boundary)
  assert.deepEqual(boundary.compactMetadata.preservedSegment, {
    headUuid: 'tail-call-message',
    anchorUuid: result.appendMessages[1]?.uuid,
    tailUuid: 'recent-4',
  })
  const active = getMessagesAfterCompactBoundary([
    ...messages,
    ...result.appendMessages,
  ])
  assert.ok(active.some(message => message.uuid === 'tail-call-message'))
  assert.ok(active.some(message => message.uuid === 'tail-result-message'))
}

function testMicroProjectionRebasesToPreservedTail(): void {
  const sessionId = createSession({ cwd: process.cwd() }).id
  const assistant: Message = {
    role: 'assistant',
    uuid: 'rebase-assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: 'rebase-call',
        toolName: BASH_TOOL_NAME,
        input: { command: 'large output' },
      },
    ],
  }
  const tool: Message = {
    role: 'tool',
    uuid: 'rebase-tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'rebase-call',
        toolName: BASH_TOOL_NAME,
        output: { type: 'text', value: 'p'.repeat(3_000) },
      },
    ],
  }
  const history: Message[] = [
    { role: 'user', content: 'run', uuid: 'rebase-user' },
    assistant,
    tool,
  ]
  try {
    const micro = microCompact(history, 0, sessionId)
    assert.notEqual(
      toolOutput(micro.messages, 'rebase-call'),
      'p'.repeat(3_000),
    )
    const boundary = createCompactBoundaryMessage('auto', 100, 'rebase-tool')
    boundary.uuid = 'rebase-boundary'
    boundary.compactMetadata.preservedSegment = {
      headUuid: 'rebase-assistant',
      anchorUuid: 'rebase-summary',
      tailUuid: 'rebase-tool',
    }
    const summary: Message = {
      role: 'user',
      content: 'summary',
      uuid: 'rebase-summary',
      isCompactSummary: true,
    }
    rebaseMicroCompactState(
      sessionId,
      [assistant, tool],
      [boundary, summary, assistant, tool],
    )
    const rebuilt = getActiveModelMessages(
      [...history, boundary, summary],
      sessionId,
    )
    assert.notEqual(toolOutput(rebuilt, 'rebase-call'), 'p'.repeat(3_000))
  } finally {
    resetMicroCompactState(sessionId)
    deleteSession(sessionId)
  }
}

function testReactiveRetryLimit(): void {
  const contextError = new Error('context length exceeded')
  assert.equal(shouldAttemptReactiveCompaction(0, contextError), true)
  assert.equal(shouldAttemptReactiveCompaction(1, contextError), false)
  assert.equal(
    shouldAttemptReactiveCompaction(0, new Error('ordinary failure')),
    false,
  )
  const belowFloorOverflow = new Error(
    'input length and `max_tokens` exceed context limit: 197500 + 16384 > 200000',
  )
  assert.equal(maxTokensOverrideFromError(belowFloorOverflow), undefined)
  assert.equal(
    shouldAttemptReactiveCompaction(0, belowFloorOverflow),
    true,
    'an overflow below the output floor must fall back to compaction',
  )
}

await testMicroProjectionLifetime()
await testReactiveTailPreservesToolPair()
testMicroProjectionRebasesToPreservedTail()
testReactiveRetryLimit()
console.log('[PASS] micro projection persists until compact boundary')
console.log('[PASS] reactive full compact references a paired recent tail')
console.log('[PASS] micro projection rebases onto preserved tail')
console.log('[PASS] reactive context retry is limited to once per step')
