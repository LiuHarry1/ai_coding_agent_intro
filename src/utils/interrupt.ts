/**
 * Claude Code–style turn interrupt markers and transcript repair.
 *
 * Transcript shape on Esc/Stop:
 *   [user prompt] → [assistant partial / tool_use…] → [tool_result…] →
 *   [user: INTERRUPT_MESSAGE]
 */
import type {
  AssistantContentPart,
  Message,
  ToolMessage,
  ToolResultPart,
  UserMessage,
} from '../core/types.js'
import { isRoleMessage } from '../core/types.js'
import { ensureMessageUuid } from '../services/session-memory/index.js'
import type { WireEmitter } from '../core/wire-emitter.js'
import { extractPartialResult } from '../tools/AgentTool/finalizeAgentTool.js'
import type { StreamResult } from '../core/agent/streamConsumer.js'
import {
  abortReasonFromSignal,
  type TurnAbortReason,
} from '../core/turn-abort-registry.js'

export const INTERRUPT_MESSAGE = '[Request interrupted by user]'
export const INTERRUPT_MESSAGE_FOR_TOOL_USE =
  '[Request interrupted by user for tool use]'

/** Synthetic tool_result content when a tool_use never got a real result. */
export const TOOL_INTERRUPT_RESULT = 'Interrupted by user'

export function isInterruptMessage(msg: Message): boolean {
  if (!isRoleMessage(msg) || msg.role !== 'user') return false
  const text =
    typeof msg.content === 'string'
      ? msg.content
      : msg.content
          .filter(
            (p): p is { type: 'text'; text: string } =>
              !!p && p.type === 'text' && typeof p.text === 'string',
          )
          .map(p => p.text)
          .join('')
  return (
    text === INTERRUPT_MESSAGE || text === INTERRUPT_MESSAGE_FOR_TOOL_USE
  )
}

export function createUserInterruptionMessage(opts?: {
  toolUse?: boolean
}): UserMessage {
  const content = opts?.toolUse
    ? INTERRUPT_MESSAGE_FOR_TOOL_USE
    : INTERRUPT_MESSAGE
  return ensureMessageUuid({ role: 'user', content })
}

/** CC yieldMissingToolResultBlocks — one error result per unpaired tool_use. */
export function missingToolResultsForAssistant(
  content: AssistantContentPart[],
  errorMessage: string = TOOL_INTERRUPT_RESULT,
): ToolResultPart[] {
  const parts: ToolResultPart[] = []
  for (const p of content) {
    if (p.type !== 'tool-call') continue
    parts.push({
      type: 'tool-result',
      toolCallId: p.toolCallId,
      toolName: p.toolName,
      output: { type: 'text', value: errorMessage },
      isError: true,
    })
  }
  return parts
}

/**
 * Commit a partially-streamed assistant turn into history (text + any
 * completed tool_use blocks), then fill missing tool_results.
 */
export function commitPartialStreamToHistory(
  messages: Message[],
  partial: StreamResult,
  wire: WireEmitter,
): { toolUse: boolean } {
  const content: AssistantContentPart[] = []
  if (partial.text.trim()) {
    content.push({ type: 'text', text: partial.text })
  }
  for (const tc of partial.toolCalls) {
    content.push({
      type: 'tool-call',
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      input: tc.input,
    })
  }
  if (content.length === 0) {
    return { toolUse: false }
  }

  messages.push(
    ensureMessageUuid({
      role: 'assistant',
      content,
      timestamp: Date.now(),
    }),
  )

  const have = new Set(partial.toolResults.map(tr => tr.toolCallId))
  const toolParts: ToolResultPart[] = partial.toolResults.map(tr => ({
    type: 'tool-result' as const,
    toolCallId: tr.toolCallId,
    toolName: tr.toolName,
    output: { type: 'text' as const, value: tr.result },
    isError: tr.isError === true || tr.result.startsWith('Error:'),
  }))

  const missing = missingToolResultsForAssistant(content).filter(
    p => !have.has(p.toolCallId),
  )
  for (const part of missing) {
    const result =
      part.output.type === 'text' ? part.output.value : TOOL_INTERRUPT_RESULT
    wire.toolResult({
      tool_use_id: part.toolCallId,
      result,
      is_error: true,
    })
    toolParts.push(part)
  }

  if (toolParts.length > 0) {
    const toolMsg: ToolMessage = {
      role: 'tool',
      content: toolParts,
    }
    messages.push(ensureMessageUuid(toolMsg))
  }

  return { toolUse: partial.toolCalls.length > 0 }
}

export type InterruptOpts = {
  toolUse?: boolean
  /** CC skips the interrupt marker when reason is submit-interrupt. */
  reason?: TurnAbortReason
  signal?: AbortSignal
}

function resolveReason(opts?: InterruptOpts): TurnAbortReason | undefined {
  if (opts?.reason) return opts.reason
  return abortReasonFromSignal(opts?.signal)
}

/**
 * Append the CC interrupt user marker and notify the wire/UI.
 * Skips if transcript already ends on an interrupt, or reason === 'interrupt'.
 */
export function appendUserInterruption(
  messages: Message[],
  wire: WireEmitter,
  opts?: InterruptOpts,
): string | undefined {
  if (resolveReason(opts) === 'interrupt') return undefined

  const last = messages.at(-1)
  if (last && isInterruptMessage(last)) {
    return opts?.toolUse
      ? INTERRUPT_MESSAGE_FOR_TOOL_USE
      : INTERRUPT_MESSAGE
  }

  const msg = createUserInterruptionMessage(opts)
  messages.push(msg)
  const text =
    typeof msg.content === 'string' ? msg.content : INTERRUPT_MESSAGE
  wire.interrupted({ tool_use: opts?.toolUse === true, text })
  return text
}

/**
 * End-of-turn abort when no in-flight stream partial needs committing
 * (between steps, or abort before any assistant output this turn).
 */
export function finalizeInterruptedTurn(
  messages: Message[],
  wire: WireEmitter,
  opts?: InterruptOpts & { finalText?: string },
): string {
  const toolUse = opts?.toolUse === true
  appendUserInterruption(messages, wire, opts)
  return (
    extractPartialResult(messages) ??
    opts?.finalText ??
    (toolUse ? INTERRUPT_MESSAGE_FOR_TOOL_USE : INTERRUPT_MESSAGE)
  )
}
