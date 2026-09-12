/**
 * Pure unit coverage for compact-boundary history projection.
 * Run: npx tsx src/scripts/test-compact-boundary.ts
 */
import assert from 'node:assert/strict'
import { projectMessagesForApi } from '../core/agent/messageSanitize.js'
import {
  createCompactBoundaryMessage,
  findLastCompactBoundaryIndex,
  getMessagesAfterCompactBoundary,
  isCompactBoundaryMessage,
} from '../core/messages/compact-boundary.js'
import type {
  AssistantMessage,
  Message,
  SystemCompactBoundaryMessage,
  UserMessage,
} from '../core/types.js'
import {
  attachTokenUsage,
  tokenCountWithEstimation,
} from '../services/compact/tokens.js'

function user(
  uuid: string,
  content: string,
  isCompactSummary = false,
): UserMessage {
  return { role: 'user', uuid, content, isCompactSummary }
}

function ids(messages: readonly Message[]): Array<string | undefined> {
  return messages.map(message => message.uuid)
}

function boundary(
  uuid: string,
  parentUuid?: string,
): SystemCompactBoundaryMessage {
  const message = createCompactBoundaryMessage('auto', 42, parentUuid)
  return { ...message, uuid, timestamp: '2026-09-12T00:00:00.000Z' }
}

function testNoBoundaryReturnsFullHistory(): void {
  const history: Message[] = [user('u1', 'one'), user('u2', 'two')]
  const projected = getMessagesAfterCompactBoundary(history)

  assert.deepEqual(projected, history)
  assert.notEqual(projected, history, 'projection should return a safe array copy')
  assert.equal(findLastCompactBoundaryIndex(history), -1)
}

function testFullCompact(): void {
  const marker = boundary('b1', 'old')
  const summary = user('s1', 'summary', true)
  const history: Message[] = [
    user('old', 'compacted away'),
    marker,
    summary,
    user('new', 'after compact'),
  ]

  assert.deepEqual(ids(getMessagesAfterCompactBoundary(history)), [
    'b1',
    's1',
    'new',
  ])
  assert.equal(isCompactBoundaryMessage(marker), true)
  assert.deepEqual(ids(projectMessagesForApi([marker, summary])), ['s1'])
}

function testLastOfMultipleBoundariesWins(): void {
  const first = boundary('b1', 'u1')
  const second = boundary('b2', 'u2')
  const history: Message[] = [
    user('u1', 'old'),
    first,
    user('s1', 'first summary', true),
    user('u2', 'middle'),
    second,
    user('s2', 'latest summary', true),
    user('u3', 'latest'),
  ]

  assert.equal(findLastCompactBoundaryIndex(history), 4)
  assert.deepEqual(ids(getMessagesAfterCompactBoundary(history)), [
    'b2',
    's2',
    'u3',
  ])
}

function testNestedPreservedTailUsesPreviousActiveProjection(): void {
  const first = boundary('b1', 'old')
  first.compactMetadata.preservedSegment = {
    headUuid: 'kept',
    anchorUuid: 's1',
    tailUuid: 'kept',
  }
  const second = boundary('b2', 'new')
  second.compactMetadata.preservedSegment = {
    headUuid: 'kept',
    anchorUuid: 's2',
    tailUuid: 'new',
  }
  const history: Message[] = [
    user('old', 'summarized first'),
    user('kept', 'preserved across both boundaries'),
    first,
    user('s1', 'first summary', true),
    user('new', 'after first compact'),
    second,
    user('s2', 'second summary', true),
    user('latest', 'after second compact'),
  ]

  const projected = getMessagesAfterCompactBoundary(history)
  assert.deepEqual(ids(projected), ['b2', 's2', 'kept', 'new', 'latest'])
  assert.equal(
    projected.some(message => message.uuid === 'b1' || message.uuid === 's1'),
    false,
    'an older boundary and summary must not leak through a nested tail',
  )
  assert.deepEqual(ids(projectMessagesForApi(projected)), [
    's2',
    'kept',
    'new',
    'latest',
  ])
}

function testPreservedTailIsRebuiltWithoutDuplicates(): void {
  const keptHead = user('k1', 'preserved one')
  const keptTail = user('k2', 'preserved two')
  const marker = boundary('b1', 'k2')
  marker.compactMetadata.messagesSummarized = 3
  marker.compactMetadata.preCompactDiscoveredTools = ['read', 'search']
  marker.compactMetadata.preservedSegment = {
    headUuid: 'k1',
    anchorUuid: 's1',
    tailUuid: 'k2',
  }
  const summary = user('s1', 'summary', true)
  const history: Message[] = [
    user('old', 'summarized'),
    keptHead,
    keptTail,
    marker,
    summary,
    keptHead,
    keptTail,
    user('new', 'after compact'),
  ]

  const projected = getMessagesAfterCompactBoundary(history)
  assert.deepEqual(ids(projected), ['b1', 's1', 'k1', 'k2', 'new'])
  assert.equal(
    new Set(ids(projected)).size,
    projected.length,
    'preserved messages must not be emitted twice',
  )
  assert.deepEqual(marker.compactMetadata.preCompactDiscoveredTools, [
    'read',
    'search',
  ])
}

function testPreservedTailUsageIsNotACompactBaseline(): void {
  const oldAssistant: AssistantMessage = {
    role: 'assistant',
    uuid: 'a1',
    content: [{ type: 'text', text: 'small preserved answer' }],
  }
  attachTokenUsage(oldAssistant, { inputTokens: 90_000, outputTokens: 10 })
  const marker = boundary('b1', 'a1')
  marker.compactMetadata.preservedSegment = {
    headUuid: 'a1',
    anchorUuid: 's1',
    tailUuid: 'a1',
  }
  const history: Message[] = [
    oldAssistant,
    marker,
    user('s1', 'compact summary', true),
  ]

  const counted = tokenCountWithEstimation(history)
  assert.equal(counted.source, 'est')
  assert.ok(counted.total < 1_000, 'stale pre-boundary usage is ignored')
}

testNoBoundaryReturnsFullHistory()
testFullCompact()
testLastOfMultipleBoundariesWins()
testNestedPreservedTailUsesPreviousActiveProjection()
testPreservedTailIsRebuiltWithoutDuplicates()
testPreservedTailUsageIsNotACompactBaseline()
console.log('[PASS] compact boundary unit tests')
