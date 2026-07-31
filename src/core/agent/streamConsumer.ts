import type { streamText } from 'ai'
import type { AgentOptions } from '../types.js'
import type { WireEmitter } from '../wire-emitter.js'
import {
  appendPreviewDelta,
  maybeStartPreview,
  type PreviewState,
} from './previewStream.js'
import { formatToolError } from './toolErrors.js'

import type { ExecutedToolResult } from '../../services/tools/tool_execution.js'

export interface StreamResult {
  text: string
  toolCalls: Array<{
    toolCallId: string
    toolName: string
    input: Record<string, unknown>
  }>
  toolResults: ExecutedToolResult[]
}

const CONTENT_EVENT_TYPES = new Set([
  'reasoning-start',
  'reasoning-delta',
  'text-delta',
  'tool-input-start',
  'tool-input-delta',
  'tool-call',
])

function streamPartText(e: { text?: string; delta?: string }): string {
  const t = e.text
  const d = e.delta
  if (typeof t === 'string' && t.length > 0) return t
  if (typeof d === 'string' && d.length > 0) return d
  return typeof t === 'string' ? t : typeof d === 'string' ? d : ''
}

function readInputDelta(event: unknown): { id?: string; delta?: string } {
  const e = event as {
    id?: string
    toolCallId?: string
    delta?: string
    inputTextDelta?: string
  }
  return { id: e.id ?? e.toolCallId, delta: e.inputTextDelta ?? e.delta }
}

export interface ConsumeStreamOptions {
  manualToolExecution?: boolean
}

export async function consumeStream(
  stream: ReturnType<typeof streamText>,
  wire: WireEmitter,
  timing?: { firstEventMs: number },
  subagentNames?: Set<string>,
  options?: ConsumeStreamOptions,
): Promise<StreamResult> {
  const isSubagentName = (n?: string): boolean =>
    !!(n && subagentNames && subagentNames.has(n))

  const toolCalls: StreamResult['toolCalls'] = []
  const toolResults: StreamResult['toolResults'] = []
  let text = ''
  let reasoningStarted = false

  const previewStates = new Map<string, PreviewState>()
  const startedInputs = new Map<string, string | undefined>()

  const flushReasoning = (): void => {
    if (reasoningStarted) {
      wire.reasoningEnd()
      reasoningStarted = false
    }
  }

  const synthesizePair = (
    id: string,
    name: string,
    input: Record<string, unknown>,
    result: string,
  ): void => {
    wire.toolCall({
      tool_use_id: id,
      name,
      args: input,
      is_subagent: isSubagentName(name),
    })
    wire.toolResult({ tool_use_id: id, result, is_error: true })
    toolCalls.push({ toolCallId: id, toolName: name, input })
    toolResults.push({ toolCallId: id, toolName: name, result })
    previewStates.delete(id)
    startedInputs.delete(id)
  }

  for await (const event of stream.fullStream) {
    if (timing && !timing.firstEventMs && CONTENT_EVENT_TYPES.has(event.type)) {
      timing.firstEventMs = Date.now()
    }
    switch (event.type) {
      case 'reasoning-start':
        reasoningStarted = true
        wire.reasoningStart()
        break

      case 'reasoning-delta': {
        if (!reasoningStarted) {
          reasoningStarted = true
          wire.reasoningStart()
        }
        const delta = streamPartText(event)
        if (delta) wire.reasoningDelta(delta)
        break
      }

      case 'reasoning-end':
        flushReasoning()
        break

      case 'text-delta': {
        flushReasoning()
        const delta = streamPartText(event)
        if (delta) {
          text += delta
          wire.textDelta(delta)
        }
        break
      }

      case 'tool-input-start': {
        flushReasoning()
        const e = event as {
          id?: string
          toolCallId?: string
          toolName?: string
        }
        const id = e.id ?? e.toolCallId
        if (!id) break
        startedInputs.set(id, e.toolName)
        wire.toolInputStart({
          tool_use_id: id,
          name: e.toolName ?? 'unknown',
          is_subagent: isSubagentName(e.toolName),
        })
        const preview = maybeStartPreview(e.toolName)
        if (preview) previewStates.set(id, preview)
        break
      }

      case 'tool-input-delta': {
        const { id, delta } = readInputDelta(event)
        if (!id || !delta) break

        wire.toolInputDelta(id, delta.length)

        const state = previewStates.get(id)
        if (state) {
          const newlyDecoded = appendPreviewDelta(state, delta)
          if (newlyDecoded) {
            wire.toolInputPreviewDelta(id, newlyDecoded)
          }
        }
        break
      }

      case 'tool-call':
        flushReasoning()
        wire.toolCall({
          tool_use_id: event.toolCallId,
          name: event.toolName,
          args: event.input,
          is_subagent: isSubagentName(event.toolName),
        })
        toolCalls.push({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.input as Record<string, unknown>,
        })
        previewStates.delete(event.toolCallId)
        startedInputs.delete(event.toolCallId)
        break

      case 'tool-error': {
        const e = event as {
          toolCallId: string
          toolName: string
          error?: unknown
          input?: unknown
        }
        synthesizePair(
          e.toolCallId,
          e.toolName,
          (e.input ?? {}) as Record<string, unknown>,
          `Error: ${formatToolError(e.toolName, e.error)}`,
        )
        break
      }

      case 'tool-result': {
        // With manualToolExecution, runToolCalls owns wire.toolResult (incl.
        // tool_use_result). Ignore SDK tool-result events so we don't paint
        // a TUR-less result that Grep/Glob cards treat as broken.
        if (options?.manualToolExecution) {
          startedInputs.delete(event.toolCallId)
          break
        }
        const raw = event.output
        const result = typeof raw === 'string' ? raw : JSON.stringify(raw)
        wire.toolResult({ tool_use_id: event.toolCallId, result })
        toolResults.push({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result,
        })
        startedInputs.delete(event.toolCallId)
        break
      }

      case 'error':
        wire.error(String(event.error))
        break
    }
  }

  flushReasoning()

  for (const [id, toolName] of startedInputs.entries()) {
    synthesizePair(
      id,
      toolName ?? 'unknown',
      {},
      'Error: Tool call was started but never completed ' +
        '(upstream stream interrupted before arguments finished — ' +
        'likely a proxy timeout or the model hit its output token limit).',
    )
  }

  if (!options?.manualToolExecution) {
    backfillMissingResults(toolCalls, toolResults, wire)
  }
  return { text, toolCalls, toolResults }
}

function backfillMissingResults(
  toolCalls: StreamResult['toolCalls'],
  toolResults: StreamResult['toolResults'],
  wire: WireEmitter,
): void {
  const seen = new Set(toolResults.map(tr => tr.toolCallId))
  for (const tc of toolCalls) {
    if (seen.has(tc.toolCallId)) continue
    const result =
      `Error: Internal — tool-call for ${tc.toolName} (id ${tc.toolCallId}) ` +
      `was received but neither tool-result nor tool-error followed. ` +
      `This indicates a bug in the AI SDK runtime, not a problem with ` +
      `the tool's arguments. Please retry.`
    console.error(`[agent] ${result}`)
    wire.toolResult({
      tool_use_id: tc.toolCallId,
      result,
      is_error: true,
    })
    toolResults.push({
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      result,
    })
  }
}
