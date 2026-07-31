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
} from '../../core/types.js'
import type { ConcurrencyPolicyFn } from '../../core/concurrency-policy.js'
import type { WireEmitter } from '../../core/wire-emitter.js'
import { formatToolError } from '../../core/agent/toolErrors.js'
import { defaultRegistry } from '../../core/tool-registry.js'
import { maybePersistAfterExecute } from '../tool-storage/index.js'

export interface ToolCallRef {
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
}

export interface ExecutedToolResult {
  toolCallId: string
  toolName: string
  result: string
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

  try {
    const raw = await tool.execute(tc.input, {
      toolCallId: tc.toolCallId,
      messages: [],
    })

    const def = lookup(tc.toolName)
    let result: string
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
      result =
        typeof mapped.content === 'string'
          ? mapped.content
          : String(mapped.content ?? '')
      isError = mapped.is_error === true

      // CC: validate Out before UI sees it (transcript/wire may be untyped JSON).
      // Mapper still runs on raw.data so the model always gets text.
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

    result = maybePersistAfterExecute(
      sessionId,
      tc.toolCallId,
      tc.toolName,
      result,
    )
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
      toolUseResult,
      followUpMessages,
      ...(isError ? { isError: true } : {}),
    }
  } catch (err) {
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
  }
}

async function executeBatchParallel(
  calls: readonly ToolCallRef[],
  tools: Record<string, AnyTool>,
  wire: WireEmitter,
  maxConcurrency: number,
  sessionId?: string,
  getDefinition?: (name: string) => ToolDefinition | undefined,
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
}

export async function runToolCalls(
  opts: RunToolCallsOptions,
): Promise<ExecutedToolResult[]> {
  const batches = partitionToolCalls(opts.toolCalls, opts.concurrencyPolicy)
  const allResults: ExecutedToolResult[] = []
  const tag = `agent:${opts.logLabel ?? 'main'}`

  for (const batch of batches) {
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
        ),
      )
    } else {
      for (const tc of batch.calls) {
        allResults.push(
          await executeOne(
            tc,
            opts.tools,
            opts.wire,
            opts.sessionId,
            opts.getDefinition,
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
      output: { type: 'text' as const, value: tr.result },
      ...(tr.toolUseResult !== undefined
        ? { toolUseResult: tr.toolUseResult }
        : {}),
      ...(tr.isError ? { isError: true } : {}),
    })),
  }
}
