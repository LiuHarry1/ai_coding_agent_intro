import * as fs from 'fs'
import type { Message, SessionMemoryConfig, TodoItem } from '../../core/types.js'
import { ensureMessageUuid } from './messageUuid.js'
import {
  calculateMessagesToKeepIndex,
  sliceMessagesToKeep,
} from './keepIndex.js'
import { getSessionMemoryPath } from './paths.js'
import {
  formatCompactSummaryMessage,
  truncateSessionMemoryForCompact,
} from './prompts.js'
import {
  getSessionMemoryState,
  waitForSessionMemoryExtraction,
} from './state.js'
import { isEmptySessionMemoryTemplate } from './template.js'
import { clearTokenUsages } from '../compact/tokens.js'

export type SessionMemoryCompactResult = {
  source: 'session_memory'
  messages: Message[]
  messagesToKeep: Message[]
  summaryText: string
}

export async function trySessionMemoryCompaction(input: {
  messages: Message[]
  sessionId: string
  config: SessionMemoryConfig
  autoCompactThreshold?: number
  attachmentMessages?: Message[]
  todos?: TodoItem[]
  fileSection?: string
  estimateTokens: (msgs: Message[]) => number
}): Promise<SessionMemoryCompactResult | null> {
  const { messages, sessionId, config } = input
  if (!config.enabled) return null

  const wait = await waitForSessionMemoryExtraction(sessionId)
  // Extract still running after wait timeout → skip SM (avoid mid-write / stale notes).
  if (!wait.ready) {
    console.log(
      '[compact] session-memory compact skipped — extract still in flight after wait',
    )
    return null
  }

  const memoryPath = getSessionMemoryPath(sessionId)
  if (!fs.existsSync(memoryPath)) return null

  let raw: string
  try {
    raw = fs.readFileSync(memoryPath, 'utf-8')
  } catch {
    return null
  }
  if (!raw.trim() || isEmptySessionMemoryTemplate(raw)) return null

  const state = getSessionMemoryState(sessionId)
  const startIndex = calculateMessagesToKeepIndex(
    messages,
    state.lastSummarizedMessageId,
    {
      minTokens: config.compactMinTokens,
      maxTokens: config.compactMaxTokens,
      minTextMessages: config.compactMinTextMessages,
    },
  )
  // Cursor set but message gone → cannot trust boundary; fall back to full.
  if (startIndex < 0) return null

  const messagesToKeep = sliceMessagesToKeep(messages, startIndex)
  const { truncatedContent, wasTruncated } =
    truncateSessionMemoryForCompact(raw)

  let summaryBody = truncatedContent
  if (input.fileSection) {
    summaryBody += `\n\n${input.fileSection}`
  }
  const todos = input.todos ?? []
  if (todos.length > 0) {
    const todoLines = todos.map(t => `- [${t.status}] ${t.id}: ${t.content}`)
    summaryBody += `\n\n## Active Todo List\nUpdate via todo_write(merge=true) as you complete items:\n${todoLines.join('\n')}`
  }

  const content = formatCompactSummaryMessage(summaryBody, {
    recentMessagesPreserved: true,
    memoryPath: wasTruncated ? memoryPath : undefined,
  })

  const summaryMsg = ensureMessageUuid({
    role: 'user' as const,
    content,
    isCompactSummary: true,
  })

  clearTokenUsages(messages)

  const built = [
    summaryMsg,
    ...messagesToKeep,
    ...(input.attachmentMessages ?? []),
  ]

  if (
    input.autoCompactThreshold !== undefined &&
    input.estimateTokens(built) >= input.autoCompactThreshold
  ) {
    return null
  }

  return {
    source: 'session_memory',
    messages: built,
    messagesToKeep,
    summaryText: truncatedContent,
  }
}
