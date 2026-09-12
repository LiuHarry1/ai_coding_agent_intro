import { randomUUID } from 'node:crypto'
import type {
  CompactMetadata,
  Message,
  SystemCompactBoundaryMessage,
} from '../types.js'
import { isRoleMessage } from '../types.js'

export function createCompactBoundaryMessage(
  trigger: CompactMetadata['trigger'],
  preTokens: number,
  lastPreCompactMessageUuid?: string,
  userContext?: string,
  messagesSummarized?: number,
): SystemCompactBoundaryMessage {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    isMeta: false,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
    level: 'info',
    compactMetadata: {
      trigger,
      preTokens,
      userContext,
      messagesSummarized,
    },
    ...(lastPreCompactMessageUuid
      ? { logicalParentUuid: lastPreCompactMessageUuid }
      : {}),
  }
}

export function isCompactBoundaryMessage(
  message: Message,
): message is SystemCompactBoundaryMessage {
  return (
    'type' in message &&
    message.type === 'system' &&
    message.subtype === 'compact_boundary'
  )
}

export function findLastCompactBoundaryIndex(
  messages: readonly Message[],
): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isCompactBoundaryMessage(messages[i]!)) return i
  }
  return -1
}

function messageUuid(message: Message): string | undefined {
  return message.uuid
}

function reconstructPreservedTail(
  historyBeforeBoundary: readonly Message[],
  boundary: SystemCompactBoundaryMessage,
): Message[] {
  const segment = boundary.compactMetadata.preservedSegment
  if (!segment) return []

  if (segment.preservedUuids?.length) {
    const byUuid = new Map(
      historyBeforeBoundary
        .filter(message => message.uuid)
        .map(message => [message.uuid!, message]),
    )
    const exact = segment.preservedUuids.map(uuid => byUuid.get(uuid))
    return exact.every((message): message is Message => message !== undefined)
      ? exact
      : []
  }

  const headIndex = historyBeforeBoundary.findIndex(
    message => messageUuid(message) === segment.headUuid,
  )
  if (headIndex === -1) return []

  let tailIndex = -1
  for (let i = historyBeforeBoundary.length - 1; i >= headIndex; i--) {
    if (messageUuid(historyBeforeBoundary[i]!) === segment.tailUuid) {
      tailIndex = i
      break
    }
  }
  if (tailIndex === -1) return []

  return historyBeforeBoundary.slice(headIndex, tailIndex + 1)
}

function appendWithoutDuplicateUuids(
  output: Message[],
  messages: readonly Message[],
  seenUuids: Set<string>,
): void {
  for (const message of messages) {
    const uuid = messageUuid(message)
    if (uuid && seenUuids.has(uuid)) continue
    output.push(message)
    if (uuid) seenUuids.add(uuid)
  }
}

/**
 * Projects full transcript history to the active compacted view.
 *
 * A live preserved segment is rebuilt from the complete history before the
 * latest boundary, then inserted after that boundary's compact summary.
 * UUID de-duplication handles transcripts which also contain physical copies
 * of preserved messages after the boundary.
 */
export function getMessagesAfterCompactBoundary(
  messages: readonly Message[],
): Message[] {
  const boundaries: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (isCompactBoundaryMessage(messages[i]!)) boundaries.push(i)
  }
  if (boundaries.length === 0) return [...messages]

  // Fold boundaries from oldest to newest. This avoids recursive array slices
  // (and stack overflow on pathological transcripts) while preserving the
  // exact active view that existed before each boundary.
  let active = messages.slice(0, boundaries[0])
  for (
    let boundaryNumber = 0;
    boundaryNumber < boundaries.length;
    boundaryNumber++
  ) {
    const boundaryIndex = boundaries[boundaryNumber]!
    const nextBoundaryIndex = boundaries[boundaryNumber + 1] ?? messages.length
    const boundary = messages[boundaryIndex] as SystemCompactBoundaryMessage
    const summaries: Message[] = []
    const remaining: Message[] = []
    for (let i = boundaryIndex + 1; i < nextBoundaryIndex; i++) {
      const message = messages[i]!
      if (
        isRoleMessage(message) &&
        message.role === 'user' &&
        message.isCompactSummary
      ) {
        summaries.push(message)
      } else {
        remaining.push(message)
      }
    }

    const preservedTail = reconstructPreservedTail(active, boundary)
    const output: Message[] = []
    const seenUuids = new Set<string>()
    appendWithoutDuplicateUuids(output, [boundary], seenUuids)
    appendWithoutDuplicateUuids(output, summaries, seenUuids)
    appendWithoutDuplicateUuids(output, preservedTail, seenUuids)
    appendWithoutDuplicateUuids(output, remaining, seenUuids)
    active = output
  }
  return active
}
