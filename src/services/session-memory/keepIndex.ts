import type { Message } from '../../core/types.js'
import { isAttachmentMessage, isRoleMessage } from '../../core/types.js'
import { findLastCompactBoundaryIndex } from '../../core/messages/compact-boundary.js'
import { estimateMessageTokens } from '../compact/tokens.js'
import { findMessageIndexByUuid } from './messageUuid.js'

export type KeepIndexConfig = {
  minTokens: number
  maxTokens: number
  minTextMessages: number
}

export function hasTextBlocks(message: Message): boolean {
  if (isAttachmentMessage(message)) return false
  if (!isRoleMessage(message)) return false
  if (message.role === 'assistant') {
    return message.content.some(b => b.type === 'text' && b.text.trim())
  }
  if (message.role === 'user') {
    if (typeof message.content === 'string') return message.content.length > 0
    return message.content.some(b => b.type === 'text' && b.text.length > 0)
  }
  return false
}

function toolResultIds(message: Message): string[] {
  if (!isRoleMessage(message) || message.role !== 'tool') return []
  return message.content.map(p => p.toolCallId)
}

function hasToolUseIds(message: Message, ids: Set<string>): boolean {
  if (!isRoleMessage(message) || message.role !== 'assistant') return false
  return message.content.some(
    b => b.type === 'tool-call' && ids.has(b.toolCallId),
  )
}

/** Do not split tool-call / tool-result pairs when choosing a keep start. */
export function adjustIndexToPreserveToolPairs(
  messages: Message[],
  startIndex: number,
): number {
  if (startIndex <= 0 || startIndex >= messages.length) return startIndex
  const floor = Math.max(0, findLastCompactBoundaryIndex(messages) + 1)
  let adjusted = startIndex
  const needed = new Set<string>()
  for (let i = startIndex; i < messages.length; i++) {
    for (const id of toolResultIds(messages[i]!)) needed.add(id)
  }
  if (needed.size === 0) {
    return adjustIndexToPreserveAssistantResponse(messages, adjusted, floor)
  }

  const present = new Set<string>()
  for (let i = adjusted; i < messages.length; i++) {
    const m = messages[i]!
    if (isRoleMessage(m) && m.role === 'assistant') {
      for (const b of m.content) {
        if (b.type === 'tool-call') present.add(b.toolCallId)
      }
    }
  }
  for (const id of present) needed.delete(id)

  for (let i = adjusted - 1; i >= floor && needed.size > 0; i--) {
    if (hasToolUseIds(messages[i]!, needed)) {
      adjusted = i
      const m = messages[i]!
      if (isRoleMessage(m) && m.role === 'assistant') {
        for (const b of m.content) {
          if (b.type === 'tool-call') needed.delete(b.toolCallId)
        }
      }
    }
  }
  return adjustIndexToPreserveAssistantResponse(messages, adjusted, floor)
}

/**
 * Assistant reasoning/text/tool-call fragments with one provider response id
 * form one API round and must remain on the same side of the keep boundary.
 */
export function adjustIndexToPreserveAssistantResponse(
  messages: Message[],
  startIndex: number,
  floor = Math.max(0, findLastCompactBoundaryIndex(messages) + 1),
): number {
  if (startIndex <= floor || startIndex >= messages.length) return startIndex

  const responseIds = new Set<string>()
  for (let i = startIndex; i < messages.length; i++) {
    const message = messages[i]!
    if (
      isRoleMessage(message) &&
      message.role === 'assistant' &&
      message.id
    ) {
      responseIds.add(message.id)
    }
  }
  if (responseIds.size === 0) return startIndex

  let adjusted = startIndex
  for (let i = startIndex - 1; i >= floor; i--) {
    const message = messages[i]!
    if (
      isRoleMessage(message) &&
      message.role === 'assistant' &&
      message.id &&
      responseIds.has(message.id)
    ) {
      adjusted = i
    }
  }
  return adjusted
}

/**
 * Choose start index for messagesToKeep.
 * - If lastSummarizedMessageId is set and found: start after it, then expand back for mins.
 * - If unset: start at end (keep nothing initially), expand back for mins.
 * - If set but missing: return -1 (caller should fall back to full compact).
 */
export function calculateMessagesToKeepIndex(
  messages: Message[],
  lastSummarizedMessageId: string | undefined,
  config: KeepIndexConfig,
): number {
  if (messages.length === 0) return 0
  const floor = Math.max(0, findLastCompactBoundaryIndex(messages) + 1)

  let lastSummarizedIndex: number
  if (lastSummarizedMessageId) {
    lastSummarizedIndex = findMessageIndexByUuid(
      messages,
      lastSummarizedMessageId,
    )
    if (lastSummarizedIndex === -1) return -1
  } else {
    lastSummarizedIndex = messages.length - 1
  }

  let startIndex = Math.max(
    floor,
    lastSummarizedIndex >= 0 ? lastSummarizedIndex + 1 : messages.length,
  )

  let totalTokens = 0
  let textCount = 0
  for (let i = startIndex; i < messages.length; i++) {
    totalTokens += estimateMessageTokens(messages[i]!)
    if (hasTextBlocks(messages[i]!)) textCount++
  }

  // Tail already over budget → forward-trim oldest kept messages.
  if (totalTokens > config.maxTokens) {
    while (
      startIndex < messages.length &&
      totalTokens > config.maxTokens
    ) {
      totalTokens -= estimateMessageTokens(messages[startIndex]!)
      startIndex++
    }
    return adjustIndexToPreserveToolPairs(messages, startIndex)
  }

  if (
    totalTokens >= config.minTokens &&
    textCount >= config.minTextMessages
  ) {
    return adjustIndexToPreserveToolPairs(messages, startIndex)
  }

  for (let i = startIndex - 1; i >= floor; i--) {
    const msg = messages[i]!
    totalTokens += estimateMessageTokens(msg)
    if (hasTextBlocks(msg)) textCount++
    startIndex = i
    if (totalTokens >= config.maxTokens) break
    if (
      totalTokens >= config.minTokens &&
      textCount >= config.minTextMessages
    ) {
      break
    }
  }

  // Expanding back may have overshot maxTokens — trim forward again.
  if (totalTokens > config.maxTokens) {
    while (
      startIndex < messages.length &&
      totalTokens > config.maxTokens
    ) {
      totalTokens -= estimateMessageTokens(messages[startIndex]!)
      startIndex++
    }
  }

  return adjustIndexToPreserveToolPairs(messages, startIndex)
}

export function sliceMessagesToKeep(
  messages: Message[],
  startIndex: number,
): Message[] {
  return messages
    .slice(Math.max(0, startIndex))
    .filter(m => !(isRoleMessage(m) && m.role === 'user' && m.isCompactSummary))
}
