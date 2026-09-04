import type { CompactEnrichment } from '../services/compact/index.js'
import { ensureMessageUuid, ensureMessageUuids } from '../services/session-memory/index.js'
import { consumeMemoryPrefetchIfReady } from '../services/auto-memory/prefetch.js'
import { getAttachmentMessages } from '../utils/attachments.js'
import { extractPartialResult } from '../tools/AgentTool/finalizeAgentTool.js'
import { finalizeInterruptedTurn } from '../utils/interrupt.js'
import type { AgentOptions, TodoItem } from './types.js'
import type { ConcurrencyPolicyFn } from './concurrency-policy.js'
import type { QueryOptions, QueryResult } from './query/types.js'
import {
  agentLogTag,
  autoCompleteTodos,
  buildUserMessage,
  syncToolSet,
} from './query/helpers.js'
import { preTurn } from './query/pre-turn.js'
import { postTurn, emitTurnEnd } from './query/post-turn.js'
import { runStep, createDumpRecorder } from './query/run-step.js'
import { forceFinalAnswerOnMaxSteps } from './query/force-final-answer.js'
import {
  BASH_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from '../constants/tool_names.js'

/** Plan approved — any of these in the same turn counts as implementation started. */
const PLAN_IMPLEMENTATION_TOOLS = new Set([
  WRITE_FILE_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
  BASH_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
])

/**
 * Unified agent query loop (CC `query()`).
 * Callers seed `messages` before invoking; `runAgent` appends the user turn.
 */
export async function query(opts: QueryOptions): Promise<QueryResult> {
  const {
    tools,
    systemPrompt,
    eventBus,
    wire,
    messages,
    maxSteps,
    model,
    subagentNames,
    deferredToolPool,
    getToolDefinition,
    canUseTool,
    concurrencyPolicy,
    sessionId,
    toolUseContext,
    refreshTools,
    refreshSystemPrompt,
    provider: configuredProvider,
    cwd,
    compaction,
    sessionMemory,
    onFullCompaction,
    onAfterStep,
    onTurnEnd,
    logLabel,
    abortSignal,
    memoryPrefetch,
  } = opts

  if (!configuredProvider) {
    throw new Error('query requires a request-scoped provider')
  }
  const provider = configuredProvider
  const resolvedModel = model ?? provider.defaultModelId()

  let finalText = ''
  let currentTodos: TodoItem[] = []
  const unsubTodo = eventBus.on('todo_update', data => {
    currentTodos = (data as { todos: TodoItem[] }).todos
  })

  const activeTools = { ...tools }
  if (toolUseContext) {
    toolUseContext.options.tools = activeTools
  }
  const pool = deferredToolPool ? { ...deferredToolPool } : undefined
  const toolPolicy: ConcurrencyPolicyFn = concurrencyPolicy ?? (() => false)
  let activeSystemPrompt = systemPrompt
  let planBuildPending = false

  const compactEnrichment: CompactEnrichment | undefined = toolUseContext
    ? {
        toolNames: Object.keys(activeTools),
        skillListingContent: toolUseContext.skillListingContent,
      }
    : undefined

  const applyPermissionModeRefresh = (newMode: string) => {
    if (refreshTools) {
      syncToolSet(activeTools, refreshTools())
      console.log(
        `[${agentLogTag(logLabel)}] refreshed tools for mode=${newMode}: ${Object.keys(activeTools).join(', ')}`,
      )
    }
    if (refreshSystemPrompt) {
      void Promise.resolve(refreshSystemPrompt()).then(prompt => {
        activeSystemPrompt = prompt
        console.log(
          `[${agentLogTag(logLabel)}] refreshed system prompt for mode=${newMode}`,
        )
      })
    }
  }

  const unsubPlanReady = eventBus.on('plan_ready', data => {
    if ((data as { approved?: boolean }).approved) {
      planBuildPending = true
    }
  })

  const unsubMode = eventBus.on('mode_changed', data => {
    const newMode = (data as { mode?: string }).mode
    if (!newMode) return
    applyPermissionModeRefresh(newMode)
  })

  const stepLimit =
    typeof maxSteps === 'number' && maxSteps > 0
      ? maxSteps
      : Number.POSITIVE_INFINITY

  const dumpPrompts = createDumpRecorder(sessionId, logLabel)

  try {
    for (let step = 0; step < stepLimit; step++) {
      if (abortSignal?.aborted) {
        const text = finalizeInterruptedTurn(messages, wire, {
          toolUse: false,
          finalText,
          signal: abortSignal,
        })
        return { finalText: text, messages, reason: 'aborted' }
      }
      wire.stepStart(step)
      const stepStart = Date.now()

      if (memoryPrefetch && memoryPrefetch.consumedOnIteration === -1) {
        await memoryPrefetch.promise
        const memAtts = await consumeMemoryPrefetchIfReady(
          memoryPrefetch,
          toolUseContext?.readFileState,
          step,
        )
        for (const att of memAtts) {
          messages.push(ensureMessageUuid(att))
        }
        if (memAtts.length > 0) {
          console.log(
            `[${agentLogTag(logLabel)}] relevant_memories attached count=${memAtts.length} step=${step}`,
          )
        }
      }

      await preTurn({
        messages,
        eventBus,
        wire,
        step,
        resolvedModel,
        provider,
        currentTodos,
        cwd,
        compaction,
        sessionMemory,
        sessionId,
        onFullCompaction,
        compactEnrichment,
        logLabel,
        readFileState: toolUseContext?.readFileState,
      })

      if (abortSignal?.aborted) {
        const text = finalizeInterruptedTurn(messages, wire, {
          toolUse: false,
          finalText,
          signal: abortSignal,
        })
        return { finalText: text, messages, reason: 'aborted' }
      }

      const stepResult = await runStep({
        messages,
        tools: activeTools,
        systemPrompt: activeSystemPrompt,
        provider,
        resolvedModel,
        eventBus,
        wire,
        subagentNames,
        step,
        stepStart,
        currentTodos,
        concurrencyPolicy: toolPolicy,
        getToolDefinition,
        canUseTool,
        cwd,
        compaction,
        sessionMemory,
        sessionId,
        onFullCompaction,
        compactEnrichment,
        logLabel,
        abortSignal,
        readFileState: toolUseContext?.readFileState,
        dumpPrompts,
      })

      if (stepResult === null) {
        if (abortSignal?.aborted) {
          const text = finalizeInterruptedTurn(messages, wire, {
            toolUse: false,
            finalText,
            signal: abortSignal,
          })
          return { finalText: text, messages, reason: 'aborted' }
        }
        const text = extractPartialResult(messages) ?? finalText
        return { finalText: text, messages, reason: 'error' }
      }

      if (stepResult.aborted) {
        const text =
          extractPartialResult(messages) ??
          (finalText || stepResult.text || '')
        return { finalText: text, messages, reason: 'aborted' }
      }

      await postTurn({
        step,
        stepResult,
        messages,
        activeTools,
        deferredPool: pool,
        eventBus,
        memoryPrefetch,
        toolUseContext,
        sessionId,
        onAfterStep,
        activeSystemPrompt,
        provider,
        resolvedModel,
        cwd,
        logLabel,
      })

      const { text, toolCalls } = stepResult
      if (text) finalText = text

      if (
        planBuildPending &&
        toolCalls.some(tc => PLAN_IMPLEMENTATION_TOOLS.has(tc.toolName))
      ) {
        planBuildPending = false
        console.log(
          '[agent] plan approved -- implementation tool called, skipping build kickoff',
        )
      }

      if (toolCalls.length === 0) {
        if (planBuildPending) {
          planBuildPending = false
          messages.push(
            ensureMessageUuid({
              role: 'user',
              content: `<system-reminder>
The user approved your plan and expects implementation to start now.
Do not reply with a summary or status update only -- call TodoWrite, Write, Edit, or Bash to make the first code change from the approved plan.
</system-reminder>`,
            }),
          )
          console.log(
            '[agent] plan approved but no tools called -- forcing implementation step',
          )
          wire.thinking()
          continue
        }
        emitTurnEnd(sessionId, onTurnEnd, {
          messages,
          systemPrompt: activeSystemPrompt,
          tools: activeTools,
          provider,
          model: resolvedModel,
          sessionId,
          cwd,
        })
        autoCompleteTodos(currentTodos, eventBus, wire)
        wire.done()
        const completedText = extractPartialResult(messages) ?? finalText
        return { finalText: completedText, messages, reason: 'completed' }
      }

      wire.thinking()
    }

    autoCompleteTodos(currentTodos, eventBus, wire)
    let text = extractPartialResult(messages) ?? finalText
    if (typeof maxSteps === 'number' && maxSteps > 0) {
      console.log(
        `[agent] maxSteps=${maxSteps} reached — forcing final answer (tools disabled)`,
      )
      const summary = await forceFinalAnswerOnMaxSteps({
        messages,
        systemPrompt: activeSystemPrompt,
        provider,
        resolvedModel,
        eventBus,
        wire,
        step: maxSteps,
        currentTodos,
        cwd,
        compaction,
        sessionMemory,
        sessionId,
        onFullCompaction,
        compactEnrichment,
      })
      if (summary) {
        text = summary
        finalText = summary
      } else {
        wire.error(`Reached max steps (${maxSteps})`)
      }
      wire.done()
      return { finalText: text, messages, reason: 'max_steps' }
    }
    wire.done()
    return { finalText: text, messages, reason: 'completed' }
  } finally {
    unsubPlanReady()
    unsubMode()
    unsubTodo()
  }
}
