/**
 * Tool execution orchestration -- services/tools/toolExecution.ts
 * Consecutive concurrency-safe calls run in parallel; mutating tools serially.
 *
 * Dual-channel tools (CC-style): execute returns `{ data }`, framework maps via
 * `ToolDefinition.mapToolResultToToolResultBlockParam` to model text, and keeps
 * `toolUseResult` for UI / transcript.
 */
import type {
  AnyTool,
  DualChannelToolResult,
  Message,
  ToolDefinition,
  ToolMessage,
  ToolResultContentBlockParam,
} from '../../core/types.js'
import type { ConcurrencyPolicyFn } from '../../core/concurrency-policy.js'
import type { WireEmitter } from '../../core/wire-emitter.js'
import { formatToolError } from '../../core/agent/toolErrors.js'
import { defaultRegistry } from '../../core/tool-registry.js'
import {
  clearToolAbort,
  registerToolAbort,
} from '../../core/tool-abort-registry.js'
import { maybePersistAfterExecute } from '../tool-storage/index.js'
import {
  blocksToToolResultOutputParts,
  hasImageBlock,
  stripImageBlocks,
  toolResultBlocksToText,
} from '../../utils/tool-result-content.js'
import { TOOL_INTERRUPT_RESULT } from '../../utils/interrupt.js'

export interface ToolCallRef {
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
}

export interface ExecutedToolResult {
  toolCallId: string
  toolName: string
  /** Text projection — wire, transcript, persistence, compaction. */
  result: string
  /**
   * Model-facing blocks, set only when the mapper returned image content.
   * `result` stays the text projection of these blocks.
   */
  resultBlocks?: ToolResultContentBlockParam[]
  toolUseResult?: unknown
  followUpMessages?: Message[]
  isError?: boolean
}

type Batch = { isConcurrencySafe: boolean; calls: ToolCallRef[] }

function getMaxToolUseConcurrency(): number {
  const parsed = parseInt(process.env.AGENT_MAX_TOOL_CONCURRENCY ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10
}

function isConcurrencySafe(
  policy: ConcurrencyPolicyFn,
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  try {
    return policy(toolName, input)
  } catch {
    return false
  }
}

export function partitionToolCalls(
  calls: readonly ToolCallRef[],
  policy: ConcurrencyPolicyFn,
): Batch[] {
  return calls.reduce((acc: Batch[], tc) => {
    const safe = isConcurrencySafe(policy, tc.toolName, tc.input)
    const last = acc[acc.length - 1]
    if (safe && last?.isConcurrencySafe) {
      last.calls.push(tc)
    } else {
      acc.push({ isConcurrencySafe: safe, calls: [tc] })
    }
    return acc
  }, [])
}

function isDualChannelReturn(raw: unknown): raw is DualChannelToolResult {
  return (
    !!raw &&
    typeof raw === 'object' &&
    'data' in raw &&
    !('result' in (raw as object))
  )
}

async function executeOne(
  tc: ToolCallRef,
  tools: Record<string, AnyTool>,
  wire: WireEmitter,
  sessionId?: string,
  getDefinition?: (name: string) => ToolDefinition | undefined,
  parentAbort?: AbortSignal,
): Promise<ExecutedToolResult> {
  const tool = tools[tc.toolName] as AnyTool & {
    execute?: (input: unknown, options?: unknown) => Promise<unknown>
  }
  const lookup = getDefinition ?? ((name: string) => defaultRegistry.get(name))

  if (!tool?.execute) {
    const errResult = `Error: Unknown tool: ${tc.toolName}`
    wire.toolResult({
      tool_use_id: tc.toolCallId,
      result: errResult,
      is_error: true,
    })
    return { toolCallId: tc.toolCallId, toolName: tc.toolName, result: errResult }
  }

  const toolSignal =
    sessionId != null
      ? registerToolAbort(sessionId, tc.toolCallId, parentAbort)
      : parentAbort

  if (toolSignal?.aborted) {
    return cancelledToolResult(tc, wire)
  }

  try {
    const raw = await tool.execute(tc.input, {
      toolCallId: tc.toolCallId,
      messages: [],
      abortSignal: toolSignal,
    })

    // If the tool finished successfully, keep its result even if the turn
    // abort raced in afterward (CC: completed tools stay in transcript).

    const def = lookup(tc.toolName)
    let result: string
    let resultBlocks: ToolResultContentBlockParam[] | undefined
    let toolUseResult: unknown | undefined
    let followUpMessages: Message[] | undefined
    let isError = false

    if (
      def?.mapToolResultToToolResultBlockParam &&
      isDualChannelReturn(raw)
    ) {
      followUpMessages = raw.newMessages
      const mapped = def.mapToolResultToToolResultBlockParam(
        raw.data,
        tc.toolCallId,
      )
      isError = mapped.is_error === true
      if (Array.isArray(mapped.content)) {
        const blocks = isError
          ? stripImageBlocks(mapped.content)
          : mapped.content
        if (hasImageBlock(blocks)) resultBlocks = blocks
        result = toolResultBlocksToText(blocks)
      } else {
        result =
          typeof mapped.content === 'string'
            ? mapped.content
            : String(mapped.content ?? '')
      }

      if (def.outputSchema) {
        const parsed = def.outputSchema.safeParse(raw.data)
        if (parsed.success) {
          toolUseResult = parsed.data ?? raw.data
        } else {
          console.warn(
            `[tools] ${tc.toolName}: outputSchema validation failed; omitting tool_use_result`,
            parsed.error,
          )
          toolUseResult = undefined
        }
      } else {
        toolUseResult = raw.data
      }
    } else if (typeof raw === 'string') {
      result = raw
      isError = raw.startsWith('Error:')
    } else if (raw && typeof raw === 'object' && 'result' in raw) {
      const structured = raw as {
        result: string
        followUpMessages?: Message[]
        newMessages?: Message[]
      }
      result = structured.result
      followUpMessages = structured.followUpMessages ?? structured.newMessages
      isError = result.startsWith('Error:')
    } else {
      result = JSON.stringify(raw)
    }

    if (!resultBlocks) {
      result = maybePersistAfterExecute(
        sessionId,
        tc.toolCallId,
        tc.toolName,
        result,
      )
    }
    wire.toolResult({
      tool_use_id: tc.toolCallId,
      result,
      ...(toolUseResult !== undefined
        ? { tool_use_result: toolUseResult }
        : {}),
      ...(isError ? { is_error: true } : {}),
    })
    return {
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      result,
      ...(resultBlocks ? { resultBlocks } : {}),
      toolUseResult,
      followUpMessages,
      ...(isError ? { isError: true } : {}),
    }
  } catch (err) {
    const aborted =
      toolSignal?.aborted ||
      (err instanceof Error && err.name === 'AbortError')
    if (aborted) return cancelledToolResult(tc, wire)
    const result = `Error: ${formatToolError(tc.toolName, err)}`
    wire.toolResult({
      tool_use_id: tc.toolCallId,
      result,
      is_error: true,
    })
    return {
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      result,
      isError: true,
    }
  } finally {
    if (sessionId) clearToolAbort(sessionId, tc.toolCallId)
  }
}

async function executeBatchParallel(
  calls: readonly ToolCallRef[],
  tools: Record<string, AnyTool>,
  wire: WireEmitter,
  maxConcurrency: number,
  sessionId?: string,
  getDefinition?: (name: string) => ToolDefinition | undefined,
  parentAbort?: AbortSignal,
): Promise<ExecutedToolResult[]> {
  const results: ExecutedToolResult[] = new Array(calls.length)
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex++
      if (i >= calls.length) return
      results[i] = await executeOne(
        calls[i]!,
        tools,
        wire,
        sessionId,
        getDefinition,
        parentAbort,
      )
    }
  }

  const workerCount = Math.min(maxConcurrency, calls.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}

export interface RunToolCallsOptions {
  toolCalls: readonly ToolCallRef[]
  tools: Record<string, AnyTool>
  wire: WireEmitter
  concurrencyPolicy: ConcurrencyPolicyFn
  sessionId?: string
  /** Agent identity for batch logs (default `main`). */
  logLabel?: string
  /** Override tool definition lookup (defaults to defaultRegistry). */
  getDefinition?: (name: string) => ToolDefinition | undefined
  /** When aborted, remaining tools get a synthetic interrupted error result. */
  abortSignal?: AbortSignal
}

function cancelledToolResult(tc: ToolCallRef, wire: WireEmitter): ExecutedToolResult {
  const errResult = TOOL_INTERRUPT_RESULT
  wire.toolResult({
    tool_use_id: tc.toolCallId,
    result: errResult,
    is_error: true,
  })
  return {
    toolCallId: tc.toolCallId,
    toolName: tc.toolName,
    result: errResult,
    isError: true,
  }
}

export async function runToolCalls(
  opts: RunToolCallsOptions,
): Promise<ExecutedToolResult[]> {
  const batches = partitionToolCalls(opts.toolCalls, opts.concurrencyPolicy)
  const allResults: ExecutedToolResult[] = []
  const tag = `agent:${opts.logLabel ?? 'main'}`
  const signal = opts.abortSignal

  for (let bi = 0; bi < batches.length; bi++) {
    if (signal?.aborted) {
      for (let bj = bi; bj < batches.length; bj++) {
        for (const tc of batches[bj]!.calls) {
          allResults.push(cancelledToolResult(tc, opts.wire))
        }
      }
      break
    }

    const batch = batches[bi]!
    if (batch.isConcurrencySafe && batch.calls.length > 1) {
      console.log(
        `[${tag}] tool batch: parallel x${batch.calls.length} (${batch.calls.map(c => c.toolName).join(', ')})`,
      )
      allResults.push(
        ...(await executeBatchParallel(
          batch.calls,
          opts.tools,
          opts.wire,
          getMaxToolUseConcurrency(),
          opts.sessionId,
          opts.getDefinition,
          signal,
        )),
      )
    } else if (batch.isConcurrencySafe) {
      allResults.push(
        await executeOne(
          batch.calls[0]!,
          opts.tools,
          opts.wire,
          opts.sessionId,
          opts.getDefinition,
          signal,
        ),
      )
    } else {
      for (let ci = 0; ci < batch.calls.length; ci++) {
        if (signal?.aborted) {
          for (let cj = ci; cj < batch.calls.length; cj++) {
            allResults.push(cancelledToolResult(batch.calls[cj]!, opts.wire))
          }
          for (let bj = bi + 1; bj < batches.length; bj++) {
            for (const tc of batches[bj]!.calls) {
              allResults.push(cancelledToolResult(tc, opts.wire))
            }
          }
          return allResults
        }
        allResults.push(
          await executeOne(
            batch.calls[ci]!,
            opts.tools,
            opts.wire,
            opts.sessionId,
            opts.getDefinition,
            signal,
          ),
        )
      }
    }
  }

  return allResults
}

export function buildToolMessage(
  results: readonly ExecutedToolResult[],
): ToolMessage {
  return {
    role: 'tool',
    content: results.map(tr => ({
      type: 'tool-result' as const,
      toolCallId: tr.toolCallId,
      toolName: tr.toolName,
      output: tr.resultBlocks
        ? {
            type: 'content' as const,
            value: blocksToToolResultOutputParts(tr.resultBlocks),
          }
        : { type: 'text' as const, value: tr.result },
      ...(tr.toolUseResult !== undefined
        ? { toolUseResult: tr.toolUseResult }
        : {}),
      ...(tr.isError ? { isError: true } : {}),
    })),
  }
}
