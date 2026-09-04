import { streamText } from 'ai'
import {
  attachTokenUsage,
  compactIfNeeded,
  tokenCountWithEstimation,
} from '../../services/compact/index.js'
import type { AttachedTokenUsage, CompactEnrichment } from '../../services/compact/index.js'
import { ensureMessageUuid, ensureMessageUuids } from '../../services/session-memory/index.js'
import {
  isContextLengthError,
  isTransientStreamError,
} from '../stream-errors.js'
import type {
  AgentOptions,
  AssistantMessage,
  Message,
  RoleMessage,
  TodoItem,
} from '../types.js'
import type { IProvider } from '../llm/types.js'
import {
  ensureToolResultPairing,
  inlineReasoningAsText,
  projectMessagesForApi,
  regroupToolResults,
  sanitizeReasoningParts,
} from '../agent/messageSanitize.js'
import { applyCacheControlBreakpoint } from '../agent/cacheControl.js'
import {
  expandAttachmentMessagesForAPI,
  mergeAdjacentUserMessages,
  smooshSystemReminderSiblings,
} from '../../utils/messages.js'
import { consumeStream, type StreamResult } from '../agent/streamConsumer.js'
import type { WireEmitter } from '../wire-emitter.js'
import { stripToolExecute } from '../agent/prepareTools.js'
import { buildToolMessage } from '../../services/tools/tool_execution.js'
import { StreamingToolExecutor } from '../../services/tools/StreamingToolExecutor.js'
import { allowAllTools, type CanUseToolFn } from '../can-use-tool.js'
import type { ToolUseContext } from '../agent/tool-use-context.js'
import { createAbortController } from '../../utils/abortController.js'
import {
  appendUserInterruption,
  commitPartialStreamToHistory,
} from '../../utils/interrupt.js'
import { abortReasonFromSignal } from '../turn-abort-registry.js'
import { profileCheckpoint } from '../../utils/startupProfiler.js'
import {
  createDumpPromptsRecorder,
  createNoopDumpPromptsRecorder,
  isDumpPromptsEnabled,
  toolsForDump,
  type DumpPromptsRecorder,
} from '../../services/api/dumpPrompts.js'
import type { ConcurrencyPolicyFn } from '../concurrency-policy.js'
import type { AnyTool } from '../types.js'
import {
  agentLogTag,
  autoCompleteTodos,
  capMaxOutputTokens,
  MAX_TRANSIENT_RETRIES,
} from './helpers.js'
import { applyFullCompaction } from './pre-turn.js'

export interface RunStepArgs {
  messages: Message[]
  tools: Record<string, AnyTool>
  toolChoice?: 'auto' | 'none' | 'required'
  systemPrompt: string
  provider: IProvider
  resolvedModel: string
  eventBus: AgentOptions['eventBus']
  wire: WireEmitter
  subagentNames?: Set<string>
  step: number
  stepStart: number
  currentTodos: TodoItem[]
  concurrencyPolicy: ConcurrencyPolicyFn
  getToolDefinition?: AgentOptions['getToolDefinition']
  canUseTool?: CanUseToolFn
  cwd?: string
  compaction?: AgentOptions['compaction']
  sessionMemory?: AgentOptions['sessionMemory']
  sessionId?: string
  onFullCompaction?: AgentOptions['onFullCompaction']
  compactEnrichment?: CompactEnrichment
  logLabel?: string
  abortSignal?: AbortSignal
  readFileState?: import('../../utils/read/types.js').ReadFileState
  dumpPrompts?: DumpPromptsRecorder
}

/**
 * One LLM round-trip, including reactive compaction / transient retry.
 */
export async function runStep(args: RunStepArgs): Promise<StreamResult | null> {
  const {
    messages,
    tools,
    toolChoice,
    systemPrompt,
    provider,
    resolvedModel,
    eventBus,
    wire,
    subagentNames,
    step,
    stepStart,
    concurrencyPolicy,
    getToolDefinition,
    canUseTool,
    cwd,
    compaction,
    sessionMemory,
    sessionId,
    logLabel,
    abortSignal,
  } = args

  const dumpPrompts = args.dumpPrompts ?? createNoopDumpPromptsRecorder()
  const apiTools = stripToolExecute(tools)
  const executors = tools

  let ctxLengthAttempt = 0
  let transientAttempt = 0
  let reactiveCompacted = false
  let requestStart = Date.now()

  const toolAbortController = createAbortController()
  if (abortSignal) {
    if (abortSignal.aborted) {
      toolAbortController.abort(abortSignal.reason)
    } else {
      abortSignal.addEventListener(
        'abort',
        () => toolAbortController.abort(abortSignal.reason),
        { once: true },
      )
    }
  }

  let streamingExecutor: StreamingToolExecutor | null = null
  const createStreamingExecutor = (): StreamingToolExecutor => {
    const toolUseContext: ToolUseContext = {
      tools: executors,
      wire,
      sessionId,
      logLabel,
      getDefinition: getToolDefinition,
      abortController: toolAbortController,
      concurrencyPolicy,
    }
    return new StreamingToolExecutor(canUseTool ?? allowAllTools, toolUseContext)
  }
  streamingExecutor = createStreamingExecutor()

  while (true) {
    try {
      const apiMessages = applyCacheControlBreakpoint(
        projectMessagesForApi(
          ensureToolResultPairing(
            smooshSystemReminderSiblings(
              mergeAdjacentUserMessages(
                regroupToolResults(
                  expandAttachmentMessagesForAPI(
                    inlineReasoningAsText(messages),
                  ),
                ),
              ),
            ),
          ),
          provider,
        ),
        provider,
      ) as RoleMessage[]

      const dumpTs = dumpPrompts.dumpRequest({
        model: resolvedModel,
        system: systemPrompt,
        messages: apiMessages,
        tools: toolsForDump(apiTools),
        ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
        provider: provider.describe(),
        step,
        logLabel: logLabel ?? 'main',
      })

      const stream = streamText({
        model: provider.chatModel(resolvedModel),
        system: systemPrompt,
        messages: apiMessages,
        tools: apiTools,
        ...(toolChoice !== undefined ? { toolChoice } : {}),
        maxOutputTokens: capMaxOutputTokens(
          tokenCountWithEstimation(messages).total,
          compaction?.contextWindow,
        ),
        maxRetries: 3,
        ...(abortSignal ? { abortSignal } : {}),
        ...provider.streamTextExtras(),
      })

      // streamText is lazy — the request goes out when consumeStream pulls.
      profileCheckpoint('turn_api_request_sent')
      const timing = { firstEventMs: 0 }
      const stepResult = await consumeStream(
        stream,
        wire,
        timing,
        subagentNames,
        {
          streamingExecutor: streamingExecutor ?? undefined,
        },
      )
      profileCheckpoint(`turn_stream_done_ttft=${timing.firstEventMs}ms`)

      if (stepResult.aborted) {
        if (streamingExecutor) {
          for await (const result of streamingExecutor.getRemainingResults()) {
            stepResult.toolResults.push(result)
          }
        }
        commitPartialStreamToHistory(messages, stepResult, wire)
        appendUserInterruption(messages, wire, {
          toolUse: false,
          signal: abortSignal,
        })
        return { ...stepResult, aborted: true, toolCalls: [], toolResults: [] }
      }

      if (streamingExecutor) {
        for await (const result of streamingExecutor.getRemainingResults()) {
          stepResult.toolResults.push(result)
        }
        stepResult.toolCalls = streamingExecutor.getAllToolCalls()
      }

      const response = await stream.response
      const sdkMessages = (
        response.messages as unknown as RoleMessage[]
      ).filter(m => m.role !== 'tool')
      sanitizeReasoningParts(sdkMessages)
      const roundId = response.id
      const receivedAt = Date.now()
      for (const m of sdkMessages) {
        if (m.role === 'assistant') {
          if (roundId) (m as AssistantMessage).id = roundId
          ;(m as AssistantMessage).timestamp = receivedAt
        }
      }
      messages.push(...sdkMessages)
      ensureMessageUuids(sdkMessages)

      if (stepResult.toolResults.length > 0) {
        messages.push(ensureMessageUuid(buildToolMessage(stepResult.toolResults)))
        for (const tr of stepResult.toolResults) {
          if (tr.followUpMessages?.length) {
            for (const fm of tr.followUpMessages) {
              messages.push(ensureMessageUuid(fm))
            }
          }
        }
      }

      if (abortSignal?.aborted) {
        appendUserInterruption(messages, wire, {
          toolUse: true,
          signal: abortSignal,
        })
        return { ...stepResult, aborted: true }
      }

      let usage: AttachedTokenUsage = {}
      try {
        usage = (await stream.usage) ?? {}
      } catch {
        // telemetry optional
      }
      if (usage.inputTokens != null || usage.totalTokens != null) {
        for (let i = sdkMessages.length - 1; i >= 0; i--) {
          if (sdkMessages[i].role === 'assistant') {
            attachTokenUsage(sdkMessages[i], usage)
            break
          }
        }
      }

      dumpPrompts.dumpResponse(dumpTs, {
        messages: sdkMessages,
        usage,
        toolCalls: stepResult.toolCalls.map(tc => ({
          toolName: tc.toolName,
          toolCallId: tc.toolCallId,
          input: tc.input,
        })),
        step,
        logLabel: logLabel ?? 'main',
      })

      logStepCompletion({
        step,
        stepStart,
        requestStart,
        firstEventMs: timing.firstEventMs,
        sdkMessages,
        toolCallsLen: stepResult.toolCalls.length,
        usage,
        reactiveCompacted,
        eventBus,
        model: resolvedModel,
        provider: provider.describe(),
        sessionId,
        logLabel,
      })
      return stepResult
    } catch (err) {
      if (
        abortSignal?.aborted ||
        (err instanceof Error && err.name === 'AbortError')
      ) {
        appendUserInterruption(messages, wire, {
          toolUse: false,
          signal: abortSignal,
          reason: abortReasonFromSignal(abortSignal),
        })
        return {
          text: '',
          toolCalls: [],
          toolResults: [],
          aborted: true,
        }
      }
      if (ctxLengthAttempt === 0 && isContextLengthError(err)) {
        const errMsg = err instanceof Error ? err.message : String(err)
        console.warn(
          `[${agentLogTag(logLabel)}] step ${step} hit context-length error -> reactive aggressive compaction. ${errMsg}`,
        )
        eventBus.emit('compaction_reactive', { error: errMsg })
        const recompacted = await compactIfNeeded(
          messages,
          eventBus,
          wire,
          resolvedModel,
          cwd ?? process.cwd(),
          args.currentTodos,
          {
            force: true,
            aggressive: true,
            enrichment: args.compactEnrichment,
            sessionMemory: args.sessionMemory,
            readFileState: args.readFileState,
          },
          compaction,
          provider,
          sessionId,
        )
        if (recompacted !== messages) {
          applyFullCompaction(
            messages,
            recompacted,
            args.currentTodos,
            args.onFullCompaction,
          )
        }
        ctxLengthAttempt++
        reactiveCompacted = true
        requestStart = Date.now()
        streamingExecutor?.discard()
        streamingExecutor = createStreamingExecutor()
        continue
      }
      if (
        transientAttempt < MAX_TRANSIENT_RETRIES &&
        isTransientStreamError(err)
      ) {
        transientAttempt++
        const backoffMs = 500 * Math.pow(3, transientAttempt - 1)
        const errMsg = err instanceof Error ? err.message : String(err)
        console.warn(
          `[${agentLogTag(logLabel)}] step ${step} transient stream error (attempt ${transientAttempt}/${MAX_TRANSIENT_RETRIES}), retrying in ${backoffMs}ms: ${errMsg}`,
        )
        eventBus.emit('transient_retry', {
          attempt: transientAttempt,
          max: MAX_TRANSIENT_RETRIES,
          backoffMs,
          error: errMsg,
        })
        await new Promise(r => setTimeout(r, backoffMs))
        requestStart = Date.now()
        streamingExecutor?.discard()
        streamingExecutor = createStreamingExecutor()
        continue
      }
      const message = err instanceof Error ? err.message : String(err)
      const cause =
        err instanceof Error && err.cause instanceof Error
          ? ` (${err.cause.message})`
          : ''
      console.error(
        `[${agentLogTag(logLabel)}] step ${step} failed: ${message}${cause}`,
      )
      wire.error(
        `Upstream stream failed: ${message}${cause}. Try again or check your proxy logs.`,
      )
      autoCompleteTodos(args.currentTodos, eventBus, wire)
      wire.done()
      return null
    }
  }
}

interface LogArgs {
  step: number
  stepStart: number
  requestStart: number
  firstEventMs: number
  sdkMessages: RoleMessage[]
  toolCallsLen: number
  usage: AttachedTokenUsage
  reactiveCompacted: boolean
  eventBus: AgentOptions['eventBus']
  model: string
  provider?: string
  sessionId?: string
  logLabel?: string
}

function logStepCompletion(a: LogArgs): void {
  const fmt = (n: number | undefined): string =>
    typeof n === 'number' ? n.toLocaleString() : '?'
  const totalMs = Date.now() - a.requestStart
  const ttfb = a.firstEventMs ? a.firstEventMs - a.requestStart : -1
  const generationMs = ttfb >= 0 ? totalMs - ttfb : -1
  const reasoningCount = a.sdkMessages.reduce(
    (n, m) =>
      n +
      (m.role === 'assistant' && Array.isArray(m.content)
        ? m.content.filter(p => p.type === 'reasoning').length
        : 0),
    0,
  )
  const usageParts = [
    `in=${fmt(a.usage.inputTokens)}`,
    `out=${fmt(a.usage.outputTokens)}`,
  ]
  if (
    typeof a.usage.reasoningTokens === 'number' &&
    a.usage.reasoningTokens > 0
  ) {
    usageParts.push(`reasoning=${fmt(a.usage.reasoningTokens)}`)
  }
  if (
    typeof a.usage.cachedInputTokens === 'number' &&
    a.usage.cachedInputTokens > 0
  ) {
    usageParts.push(`cached=${fmt(a.usage.cachedInputTokens)}`)
  }
  const tag = agentLogTag(a.logLabel)
  console.log(
    `[${tag}] step ${a.step} done -- total=${totalMs}ms ` +
      `(ttfb=${ttfb}ms upstream-wait, gen=${generationMs}ms streaming), ` +
      `usage[${usageParts.join(' ')}], ` +
      `reasoning_blocks=${reasoningCount}, tool_calls=${a.toolCallsLen}, ` +
      `step_total=${Date.now() - a.stepStart}ms` +
      (a.reactiveCompacted ? ', reactive_compaction=yes' : ''),
  )

  a.eventBus.emit('usage', {
    step: a.step,
    sessionId: a.sessionId,
    model: a.model,
    provider: a.provider,
    inputTokens: a.usage.inputTokens ?? 0,
    outputTokens: a.usage.outputTokens ?? 0,
    cachedInputTokens: a.usage.cachedInputTokens ?? 0,
    reasoningTokens: a.usage.reasoningTokens ?? 0,
    totalTokens:
      a.usage.totalTokens ??
      (a.usage.inputTokens ?? 0) + (a.usage.outputTokens ?? 0),
    latencyMs: totalMs,
    ttfbMs: ttfb >= 0 ? ttfb : undefined,
    toolCalls: a.toolCallsLen,
  })
}

export function createDumpRecorder(
  sessionId: string | undefined,
  logLabel?: string,
): DumpPromptsRecorder {
  const dumpKey = logLabel
    ? `${sessionId ?? 'unknown'}__${logLabel}`
    : (sessionId ?? 'unknown')
  return isDumpPromptsEnabled()
    ? createDumpPromptsRecorder(dumpKey)
    : createNoopDumpPromptsRecorder()
}
