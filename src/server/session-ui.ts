import type { Message, ToolResultOutput } from '../core/types.js'
import { randomUUID } from 'crypto'
import * as fs from 'fs'
import { isAttachmentMessage, isRoleMessage } from '../core/types.js'
import { getSessionTranscriptPath } from '../session/index.js'
import { getSubagentNames } from '../tools/AgentTool/index.js'
import { defaultRegistry } from '../tools.js'
import { isSystemReminderContent } from '../utils/system-reminder.js'
import {
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  isInterruptMessage,
} from '../utils/interrupt.js'
import { toolResultOutputToText } from '../utils/tool-result-content.js'
import { projectLegacyFatToolUseResult } from '../utils/project-tool-use-result.js'

const COMPACT_SUMMARY_PREFIX =
  '[Previous conversation compacted — context continues below]\n\n'
const COMPACT_SUMMARY_FOOTER =
  '\n\nContinue from where you left off without asking questions.'
const UI_RESULT_MAX_CHARS = 2_000

function truncateUiResult(text: string): string {
  if (text.length <= UI_RESULT_MAX_CHARS) return text
  return `${text.slice(0, UI_RESULT_MAX_CHARS - 1)}…`
}

function userMessageText(msg: Message): string {
  if (!isRoleMessage(msg) || msg.role !== 'user') return ''
  return typeof msg.content === 'string'
    ? msg.content
    : (msg.content as Array<{ type: string; text?: string }>)
        .filter(p => p.type === 'text')
        .map(p => p.text)
        .join('')
}

/** Short upload URLs for the UI — never revive Buffer / data URLs into React. */
function userMessageImageUrls(msg: Message): string[] | undefined {
  if (!isRoleMessage(msg) || msg.role !== 'user') return undefined
  if (!Array.isArray(msg.content)) return undefined
  const urls: string[] = []
  for (const part of msg.content as Array<{
    type?: string
    image?: unknown
  }>) {
    if (part.type !== 'image') continue
    if (
      typeof part.image === 'string' &&
      part.image.startsWith('/sessions/') &&
      part.image.includes('/uploads/')
    ) {
      urls.push(part.image)
    }
  }
  return urls.length ? urls : undefined
}

/** compact summary is model-only; UI gets a boundary marker. */
function isCompactSummaryMessage(msg: Message): boolean {
  if (!isRoleMessage(msg) || msg.role !== 'user') return false
  if (msg.isCompactSummary) return true
  const text = userMessageText(msg)
  return text.startsWith(COMPACT_SUMMARY_PREFIX)
}

function extractCompactSummaryBody(content: string): string {
  if (!content.startsWith(COMPACT_SUMMARY_PREFIX)) return content
  let body = content.slice(COMPACT_SUMMARY_PREFIX.length)
  const footerIdx = body.indexOf(COMPACT_SUMMARY_FOOTER)
  if (footerIdx >= 0) body = body.slice(0, footerIdx)
  body = body.trim()
  const MAX_SUMMARY = 4_000
  if (body.length > MAX_SUMMARY) return `${body.slice(0, MAX_SUMMARY - 1)}…`
  return body
}

type UIPart = {
  type: string
  content?: string
  toolCallId?: string
  result?: string
  toolUseResult?: unknown
  isError?: boolean
  name?: string
  args?: unknown
  status?: string
  isSubagent?: boolean
}

type UIAssistantMessage = {
  type: 'assistant'
  id?: string
  parts: UIPart[]
  status: 'done'
}

export type UICompactBoundaryMessage = {
  type: 'compact_boundary'
  id?: string
  summary: string
  summaryLength: number
  messagesBefore?: number
}

/** Append one stored assistant message's displayable parts onto a UI turn. */
function appendAssistantParts(
  target: UIAssistantMessage,
  content: Array<{
    type: string
    text?: string
    toolCallId?: string
    toolName?: string
    input?: unknown
  }>,
  subagentNames: Set<string>,
): void {
  for (const part of content) {
    if (part.type === 'text' && part.text?.trim()) {
      target.parts.push({ type: 'text', content: part.text })
    } else if (part.type === 'reasoning' && part.text?.trim()) {
      target.parts.push({
        type: 'reasoning',
        content: part.text,
        status: 'done',
      })
    } else if (part.type === 'tool-call') {
      target.parts.push({
        type: 'tool_call',
        name: part.toolName,
        toolCallId: part.toolCallId,
        args: part.input,
        status: 'done',
        isSubagent: subagentNames.has(part.toolName ?? ''),
      })
    }
  }
}

/**
 * Convert agent messages to flat UI format for the web client.
 *
 * One user turn can produce many stored assistant/tool messages (tool-call →
 * tool-result → tool-call …). While streaming, the frontend accumulates all of
 * those into a single assistant bubble; merge consecutive assistant parts here
 * so session reload matches that layout.
 *
 * isCompactSummary user messages become compact_boundary markers,
 * not raw user bubbles with the full summary text.
 */
export function sessionToUIMessages(messages: Message[]): unknown[] {
  const uiMessages: unknown[] = []
  const subagentNames = getSubagentNames(defaultRegistry)
  let currentAssistant: UIAssistantMessage | null = null

  for (const msg of messages) {
    if (isAttachmentMessage(msg)) continue
    if (msg.role === 'user') {
      currentAssistant = null
      const content = userMessageText(msg)
      if (isSystemReminderContent(content)) continue
      if (isInterruptMessage(msg)) {
        uiMessages.push({
          type: 'interrupted',
          id: randomUUID(),
          toolUse: content === INTERRUPT_MESSAGE_FOR_TOOL_USE,
          text: content || INTERRUPT_MESSAGE,
        })
        continue
      }
      if (isCompactSummaryMessage(msg)) {
        const summary = extractCompactSummaryBody(content)
        uiMessages.push({
          type: 'compact_boundary',
          id: randomUUID(),
          summary,
          summaryLength: summary.length,
        } satisfies UICompactBoundaryMessage)
        continue
      }
      const images = userMessageImageUrls(msg)
      uiMessages.push({
        type: 'user',
        id: randomUUID(),
        content,
        ...(images ? { images } : {}),
      })
    } else if (msg.role === 'assistant') {
      if (!currentAssistant) {
        currentAssistant = {
          type: 'assistant',
          id: randomUUID(),
          parts: [],
          status: 'done',
        }
        uiMessages.push(currentAssistant)
      }
      appendAssistantParts(
        currentAssistant,
        msg.content as Array<{
          type: string
          text?: string
          toolCallId?: string
          toolName?: string
          input?: unknown
        }>,
        subagentNames,
      )
    } else if (msg.role === 'tool') {
      if (currentAssistant) {
        for (const tr of msg.content as Array<{
          type: string
          toolCallId: string
          toolName: string
          output?: ToolResultOutput
          toolUseResult?: unknown
          isError?: boolean
        }>) {
          const tc = currentAssistant.parts.find(
            p => p.type === 'tool_call' && p.toolCallId === tr.toolCallId,
          )
          if (tc) {
            tc.result = truncateUiResult(toolResultOutputToText(tr.output))
            if (tr.toolUseResult !== undefined) {
              tc.toolUseResult = projectLegacyFatToolUseResult(
                tr.toolName ?? tc.name,
                tr.toolUseResult,
              )
            }
            if (tr.isError) tc.isError = true
          }
        }
      }
    }
  }

  return uiMessages
}

type JsonlReplayItem =
  | { kind: 'message'; message: Message }
  | {
      kind: 'compact_boundary'
      summary: string
      messagesBefore: number
    }

/**
 * Replay the append-only JSONL without collapsing at
 * `compacted` checkpoints. Agent restore still uses restoreFromDisk(); UI uses
 * this path so Cursor-style chat shows the full scrollback (micro-compact never
 * wrote cleared tool payloads to disk; full-compact pre-checkpoint lines remain).
 */
function replaySessionJsonl(sessionId: string): JsonlReplayItem[] {
  const filePath = getSessionTranscriptPath(sessionId)
  if (!filePath || !fs.existsSync(filePath)) return []

  const raw = fs.readFileSync(filePath, 'utf-8').trim()
  if (!raw) return []

  const items: JsonlReplayItem[] = []
  let transcriptLineCount = 0

  for (const line of raw
    .split('\n')
    .map(l => JSON.parse(l) as Record<string, unknown>)) {
    if (line.type === 'message') {
      const { type: _, timestamp: __, ...msg } = line
      items.push({ kind: 'message', message: msg as unknown as Message })
      transcriptLineCount++
    } else if (line.type === 'attachment') {
      const { timestamp: _, ...msg } = line
      items.push({ kind: 'message', message: msg as unknown as Message })
      transcriptLineCount++
    } else if (line.type === 'compacted') {
      const checkpoint = Array.isArray(line.messages)
        ? (line.messages as Message[])
        : []
      const summaryMsg = checkpoint.find(m => isCompactSummaryMessage(m))
      const summary = summaryMsg
        ? extractCompactSummaryBody(userMessageText(summaryMsg))
        : ''
      items.push({
        kind: 'compact_boundary',
        summary,
        messagesBefore: transcriptLineCount,
      })
      // Lines up to here were consumed by THIS compaction. Reset so the next
      // boundary reports its own span, not a session-lifetime running total
      // (which showed ever-growing "(N messages summarized)" counts).
      transcriptLineCount = 0
    }
  }

  return items
}

/** Full session transcript for the web UI (reads `.sessions/{id}.jsonl`). */
export function sessionJsonlToUIMessages(sessionId: string): unknown[] {
  const items = replaySessionJsonl(sessionId)
  const ui: unknown[] = []
  let batch: Message[] = []

  const flushBatch = (): void => {
    if (batch.length === 0) return
    ui.push(...sessionToUIMessages(batch))
    batch = []
  }

  for (const item of items) {
    if (item.kind === 'compact_boundary') {
      flushBatch()
      ui.push({
        type: 'compact_boundary',
        id: randomUUID(),
        summary: item.summary,
        summaryLength: item.summary.length,
        messagesBefore: item.messagesBefore,
      } satisfies UICompactBoundaryMessage)
      continue
    }
    batch.push(item.message)
  }
  flushBatch()
  return ui
}
