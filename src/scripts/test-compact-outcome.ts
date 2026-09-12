/**
 * Micro vs full compact outcome + persist callback.
 * Run: npx tsx src/scripts/test-compact-outcome.ts
 */
import assert from 'node:assert/strict'
import { EventBus } from '../core/event-bus.js'
import { noopWireEmitter } from '../core/wire-emitter.js'
import { isRoleMessage } from '../core/types.js'
import type { Message } from '../core/types.js'
import { applyCompactOutcome } from '../core/query/pre-turn.js'
import { BASH_TOOL_NAME } from '../constants/tool_names.js'
import {
  compactIfNeeded,
  resetCompactionFailures,
} from '../services/compact/index.js'
import { attachTokenUsage } from '../services/compact/tokens.js'
import {
  createCompactBoundaryMessage,
  getMessagesAfterCompactBoundary,
} from '../core/messages/compact-boundary.js'

const USER_TEXT = '开始填'
const BIG = 'x'.repeat(2500)

function countUserTurns(messages: Message[], text: string): number {
  return messages.filter(
    m =>
      isRoleMessage(m) &&
      m.role === 'user' &&
      !m.isCompactSummary &&
      m.content === text,
  ).length
}

function bashPair(i: number): Message[] {
  const id = `t${i}`
  return [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: id,
          toolName: BASH_TOOL_NAME,
          input: { command: `echo ${i}` },
        },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: id,
          toolName: BASH_TOOL_NAME,
          output: { type: 'text', value: BIG },
        },
      ],
    },
  ]
}

function buildOverMicroUnderFull(): Message[] {
  const last: Message = {
    role: 'assistant',
    content: [{ type: 'text', text: 'ready' }],
  }
  attachTokenUsage(last, { inputTokens: 30_000, outputTokens: 20 })
  return [
    { role: 'user', content: USER_TEXT },
    ...Array.from({ length: 8 }, (_, i) => bashPair(i)).flat(),
    last,
  ]
}

async function main(): Promise<void> {
  resetCompactionFailures()
  const prevOverride = process.env.COMPACT_THRESHOLD_OVERRIDE
  process.env.COMPACT_THRESHOLD_OVERRIDE = '50000'
  try {
    const seed = buildOverMicroUnderFull()
    const eventBus = new EventBus()
    const outcome = await compactIfNeeded(
      seed,
      eventBus,
      noopWireEmitter,
      'test-model',
      process.cwd(),
      [],
    )

    assert.equal(
      outcome.source,
      'micro',
      `expected micro, got ${outcome.source}`,
    )
    assert.equal(
      outcome.messages.some(
        m => isRoleMessage(m) && m.role === 'user' && m.isCompactSummary,
      ),
      false,
      'micro must not inject a compact summary',
    )
    assert.equal(countUserTurns(outcome.messages, USER_TEXT), 1)
    console.log('[ok] over micro / under full threshold -> source=micro')

    let persistCalls = 0
    const live = [...seed]
    const microView = applyCompactOutcome(live, outcome, [], () => {
      persistCalls++
    })
    assert.equal(persistCalls, 0, 'onFullCompaction must not run for micro')
    assert.equal(countUserTurns(live, USER_TEXT), 1)
    assert.equal(microView, outcome.messages)
    console.log('[ok] applyCompactOutcome(micro) does not checkpoint')

    persistCalls = 0
    const already = [{ role: 'user' as const, content: USER_TEXT }]
    const appendMessages: Message[] = [
      createCompactBoundaryMessage('auto', 123),
      {
        role: 'user',
        content: '[Previous conversation compacted]\nContinue.',
        isCompactSummary: true,
      },
    ]
    const active = applyCompactOutcome(
      already,
      {
        messages: appendMessages,
        appendMessages,
        source: 'full',
      },
      [],
      compacted => {
        persistCalls++
        assert.equal(
          countUserTurns([...compacted], USER_TEXT),
          0,
          'append events must not physically copy the verbatim tail',
        )
      },
    )
    assert.equal(persistCalls, 1, 'onFullCompaction must run for full')
    assert.equal(countUserTurns(already, USER_TEXT), 1)
    assert.deepEqual(active, getMessagesAfterCompactBoundary(already))
    assert.equal(
      countUserTurns(active, USER_TEXT),
      0,
      'full compact active view has no verbatim tail',
    )
    console.log('[ok] full compact appends boundary without replacing transcript')
  } finally {
    if (prevOverride === undefined) delete process.env.COMPACT_THRESHOLD_OVERRIDE
    else process.env.COMPACT_THRESHOLD_OVERRIDE = prevOverride
    resetCompactionFailures()
  }

  console.log('[PASS] compact outcome split')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
