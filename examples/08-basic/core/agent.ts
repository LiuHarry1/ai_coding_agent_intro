import { streamText } from 'ai'
import {
  attachTokenUsage,
  compactIfNeeded,
  tokenCountWithEstimation,
} from '../services/compact/index.js'
import type { AttachedTokenUsage } from '../services/compact/index.js'
import {
  isContextLengthError,
  isTransientStreamError,
} from './stream-errors.js'
import type {
  AgentOptions,
  Message,
  AssistantMessage,
  UserMessage,
  UserContentPart,
  TodoItem,
  TodoStatus,
  RoleMessage,
} from './types.js'
import { isRoleMessage } from './types.js'
import type { IProvider } from './llm/types.js'
import {
  ensureToolResultPairing,
  inlineReasoningAsText,
  regroupToolResults,
  sanitizeReasoningParts,
} from './agent/messageSanitize.js'
import { applyCacheControlBreakpoint } from './agent/cacheControl.js'
import {
  expandAttachmentMessagesForAPI,
  mergeAdjacentUserMessages,
  smooshSystemReminderSiblings,
} from '../utils/messages.js'
import { getAttachmentMessages } from '../utils/attachments.js'
import { consumeStream, type StreamResult } from './agent/streamConsumer.js'
import { stripToolExecute } from './agent/prepareTools.js'
import {
  buildToolMessage,
  runToolCalls,
} from '../services/tools/tool_execution.js'
import {
  BASH_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
  TOOL_SEARCH_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from '../constants/tool_names.js'
import type { ConcurrencyPolicyFn } from './concurrency-policy.js'
import type { AnyTool } from './types.js'

/** Default per-step output cap when the provider SDK cannot infer model limits. */
const DEFAULT_MAX_OUTPUT_TOKENS = 128_000

function getMaxOutputTokens(): number {
  const parsed = parseInt(process.env.AGENT_MAX_OUTPUT_TOKENS ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_OUTPUT_TOKENS
}

// ── User-message helpers ────────────────────────────

function parseDataUrl(dataUrl: string): { buffer: Buffer; mediaType: string } {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) throw new Error('Invalid data URL')
  return { mediaType: match[1], buffer: Buffer.from(match[2], 'base64') }
}

function buildUserMessage(text: string, images?: string[]): UserMessage {
  if (!images || images.length === 0) {
    return { role: 'user', content: text }
  }
  const parts: UserContentPart[] = [{ type: 'text', text }]
  for (const dataUrl of images) {
    const { buffer, mediaType } = parseDataUrl(dataUrl)
    parts.push({ type: 'image', image: buffer, mediaType })
  }
  return { role: 'user', content: parts }
}

// ── Todo helpers ────────────────────────────────────

function autoCompleteTodos(
  todos: TodoItem[],
  eventBus: AgentOptions['eventBus'],
): void {
  const hasIncomplete = todos.some(
    t => t.status === 'pending' || t.status === 'in_progress',
  )
  if (!hasIncomplete) return
  const updated = todos.map(t =>
    t.status === 'pending' || t.status === 'in_progress'
      ? { ...t, status: 'completed' as TodoStatus }
      : t,
  )
  eventBus.emit('todo_update', { todos: updated })
}

function formatTodoReminder(todos: TodoItem[]): string {
  const lines = todos.map(t => `- [${t.status}] ${t.id}: ${t.content}`)
  return `[Active todo list — update via ${TODO_WRITE_TOOL_NAME}(merge=true) as you complete items]\n${lines.join('\n')}`
}

/**
 * After a full compaction we may have rewritten the entire history. If the
 * pre-compaction state had an active todo list, re-attach it as a system
 * reminder on the last assistant message so the model doesn't forget what
 * it was working on. Mutates `messages` in place.
 */
function attachTodoReminderAfterCompaction(
  messages: Message[],
  todos: TodoItem[],
): void {
  if (todos.length === 0) return
  const last = messages[messages.length - 1]
  if (!last || !isRoleMessage(last) || last.role !== 'assistant' || !Array.isArray(last.content))
    return
  const existing = last.content.find(p => p.type === 'text')
  const reminder = '\n\n' + formatTodoReminder(todos)
  if (existing && 'text' in existing) {
    existing.text += reminder
  } else {
    last.content.push({ type: 'text', text: reminder })
  }
}

// ── Deferred-tool activation ────────────────────────

/**
 * After each step, check if the model called `tool_search`. If so,
 * extract the `matches` array from tool results and move matching tools
 * from the deferred pool into the active set so the next step can use
 * them. Activates deferred tools mid-turn.
 */
function activateDeferredTools(
  toolCalls: StreamResult['toolCalls'],
  pool: Record<string, AnyTool>,
  active: Record<string, AnyTool>,
  discovered: Set<string>,
): void {
  for (const tc of toolCalls) {
    if (tc.toolName !== TOOL_SEARCH_TOOL_NAME) continue

    // The tool_search execute returns { matches: string[], text, ... }.
    // In the stream result, the input is what we sent; the result comes
    // via the corresponding toolResult entry.  But we can also parse the
    // query's select: prefix to know what was requested.  Simplest: look
    // at the query input and activate all names found in the pool.
    const query = (tc.input as any)?.query as string | undefined
    if (!query) continue

    const trimmed = query.trim()
    let names: string[] = []

    if (trimmed.toLowerCase().startsWith('select:')) {
      names = trimmed
        .slice(7)
        .split(',')
        .map(n => n.trim())
        .filter(Boolean)
    } else {
      // For keyword queries, we can't know exact matches until the result.
      // Activate all pool tools whose name partially matches the keywords.
      const kw = trimmed.toLowerCase().split(/\s+/).filter(Boolean)
      for (const name of Object.keys(pool)) {
        if (kw.some(k => name.toLowerCase().includes(k))) {
          names.push(name)
        }
      }
    }

    for (const name of names) {
      if (pool[name] && !active[name]) {
        active[name] = pool[name]
        delete pool[name]
        discovered.add(name)
        console.log(`[agent] activated deferred tool: ${name}`)
      }
    }
  }
}

// ── runAgent ────────────────────────────────────────

// Two independent retry budgets:
//   - ctxLengthAttempt (max 1): on 413 / context_length_exceeded, run
//     aggressive compaction and try once more.
//   - transientAttempt (max 2): on socket-closed / 5xx / undici
//     "terminated", just resend with backoff (proxy hiccup, no
//     compaction needed). Common with copilot-api on long bodies.
const MAX_TRANSIENT_RETRIES = 2

/** Plan approved — any of these in the same turn counts as implementation started. */
const PLAN_IMPLEMENTATION_TOOLS = new Set([
  WRITE_FILE_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
  BASH_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
])

function syncToolSet(
  target: Record<string, AnyTool>,
  source: Record<string, AnyTool>,
): void {
  for (const key of Object.keys(target)) {
    if (!(key in source)) delete target[key]
  }
  Object.assign(target, source)
}

export async function runAgent(
  userMessage: string,
  {
    tools,
    systemPrompt,
    eventBus,
    messages = [],
    images,
    maxSteps = 80,
    model,
    subagentNames,
    deferredToolPool,
    concurrencyPolicy,
    sessionId,
    toolUseContext,
    refreshTools,
    refreshSystemPrompt,
    provider: configuredProvider,
    cwd,
    compaction,
    onFullCompaction,
  }: AgentOptions,
): Promise<string> {
  if (toolUseContext) {
    for await (const att of getAttachmentMessages(
      userMessage,
      toolUseContext,
      messages,
    )) {
      messages.push(att)
    }
  }
  messages.push(buildUserMessage(userMessage, images))

  let finalText = ''
  if (!configuredProvider) {
    throw new Error('runAgent requires a request-scoped provider')
  }
  const provider = configuredProvider
  const resolvedModel = model ?? provider.defaultModelId()

  let currentTodos: TodoItem[] = []
  const unsubTodo = eventBus.on('todo_update', data => {
    currentTodos = (data as { todos: TodoItem[] }).todos
  })

  // Mutable copy so we can activate deferred tools mid-loop.
  const activeTools = { ...tools }
  if (toolUseContext) {
    toolUseContext.options.tools = activeTools
  }
  const pool = deferredToolPool ? { ...deferredToolPool } : undefined
  const toolPolicy: ConcurrencyPolicyFn = concurrencyPolicy ?? (() => false)
  let activeSystemPrompt = systemPrompt
  let planBuildPending = false

  const applyPermissionModeRefresh = (newMode: string) => {
    if (refreshTools) {
      syncToolSet(activeTools, refreshTools())
      console.log(
        `[agent] refreshed tools for mode=${newMode}: ${Object.keys(activeTools).join(', ')}`,
      )
    }
    if (refreshSystemPrompt) {
      activeSystemPrompt = refreshSystemPrompt()
      console.log(`[agent] refreshed system prompt for mode=${newMode}`)
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

  try {
    for (let step = 0; step < maxSteps; step++) {
      eventBus.emit('step_start', { step })
      const stepStart = Date.now()

      await runCompactionAndLog(
        messages,
        eventBus,
        step,
        resolvedModel,
        provider,
        currentTodos,
        cwd,
        compaction,
        sessionId,
        onFullCompaction,
      )

      const stepResult = await runOneStep({
        messages,
        tools: activeTools,
        systemPrompt: activeSystemPrompt,
        provider,
        resolvedModel,
        eventBus,
        subagentNames,
        step,
        stepStart,
        currentTodos,
        concurrencyPolicy: toolPolicy,
        cwd,
        compaction,
        sessionId,
        onFullCompaction,
      })

      if (stepResult === null) {
        return finalText
      }

      const { text, toolCalls } = stepResult
      if (text) finalText = text

      // Activate tools discovered via tool_search in this step.
      if (pool) {
        const newlyDiscovered = new Set<string>()
        activateDeferredTools(toolCalls, pool, activeTools, newlyDiscovered)
        if (newlyDiscovered.size > 0) {
          eventBus.emit('tools_discovered', {
            tools: [...newlyDiscovered],
          })
        }
      }

      if (
        planBuildPending &&
        toolCalls.some(tc => PLAN_IMPLEMENTATION_TOOLS.has(tc.toolName))
      ) {
        planBuildPending = false
        console.log(
          '[agent] plan approved — implementation tool called, skipping build kickoff',
        )
      }

      if (toolCalls.length === 0) {
        if (planBuildPending) {
          planBuildPending = false
          messages.push({
            role: 'user',
            content: `<system-reminder>
The user approved your plan and expects implementation to start now.
Do not reply with a summary or status update only — call TodoWrite, Write, Edit, or Bash to make the first code change from the approved plan.
</system-reminder>`,
          })
          console.log(
            '[agent] plan approved but no tools called — forcing implementation step',
          )
          eventBus.emit('thinking', {})
          continue
        }
        autoCompleteTodos(currentTodos, eventBus)
        eventBus.emit('done', { steps: step + 1 })
        return finalText
      }

      if (toolUseContext) {
        for await (const att of getAttachmentMessages(
          null,
          toolUseContext,
          messages,
        )) {
          messages.push(att)
        }
      }

      eventBus.emit('thinking', {})
    }

    autoCompleteTodos(currentTodos, eventBus)
    eventBus.emit('error', { message: `Reached max steps (${maxSteps})` })
    eventBus.emit('done', { steps: maxSteps })
    return finalText
  } finally {
    unsubPlanReady()
    unsubMode()
    unsubTodo()
  }
}

function applyFullCompaction(
  messages: Message[],
  managed: Message[],
  currentTodos: TodoItem[],
  onFullCompaction?: AgentOptions['onFullCompaction'],
): void {
  messages.length = 0
  messages.push(...managed)
  attachTodoReminderAfterCompaction(messages, currentTodos)
  onFullCompaction?.(messages)
}

async function runCompactionAndLog(
  messages: Message[],
  eventBus: AgentOptions['eventBus'],
  step: number,
  resolvedModel: string,
  provider: IProvider,
  currentTodos: TodoItem[],
  cwd?: string,
  compaction?: AgentOptions['compaction'],
  sessionId?: string,
  onFullCompaction?: AgentOptions['onFullCompaction'],
): Promise<void> {
  const compactStart = Date.now()
  const managed = await compactIfNeeded(
    messages,
    eventBus,
    resolvedModel,
    cwd ?? process.cwd(),
    currentTodos,
    {},
    compaction,
    provider,
    sessionId,
  )
  const compactMs = Date.now() - compactStart

  const counted = tokenCountWithEstimation(messages)
  const tokenLabel =
    counted.source === 'real+est'
      ? `${counted.total.toLocaleString()} tokens ` +
        `(${counted.realBaseline?.toLocaleString()} real + ${counted.estimatedDelta?.toLocaleString()} est)`
      : `~${counted.total.toLocaleString()} tokens (est, no usage cached yet)`
  console.log(
    `[agent] step ${step} start — ${messages.length} msgs, ${tokenLabel}, ` +
      `model=${resolvedModel}, llm=${provider.describe()}` +
      (compactMs > 50 ? `, compaction=${compactMs}ms` : ''),
  )

  if (managed !== messages) {
    applyFullCompaction(messages, managed, currentTodos, onFullCompaction)
  }
}

interface RunOneStepArgs {
  messages: Message[]
  tools: AgentOptions['tools']
  systemPrompt: string
  provider: IProvider
  resolvedModel: string
  eventBus: AgentOptions['eventBus']
  subagentNames?: Set<string>
  step: number
  stepStart: number
  currentTodos: TodoItem[]
  concurrencyPolicy: ConcurrencyPolicyFn
  cwd?: string
  compaction?: AgentOptions['compaction']
  sessionId?: string
  onFullCompaction?: AgentOptions['onFullCompaction']
}

/**
 * One LLM round-trip, including reactive compaction / transient retry.
 *
 * Returns `null` when the step terminally fails (error + done events
 * already emitted, caller should return finalText immediately). Returns
 * the StreamResult on success.
 */
async function runOneStep(args: RunOneStepArgs): Promise<StreamResult | null> {
  const {
    messages,
    tools,
    systemPrompt,
    provider,
    resolvedModel,
    eventBus,
    subagentNames,
    step,
    stepStart,
    concurrencyPolicy,
    cwd,
    compaction,
    sessionId,
  } = args

  const apiTools = stripToolExecute(tools)
  const executors = tools

  let ctxLengthAttempt = 0
  let transientAttempt = 0
  let reactiveCompacted = false
  let requestStart = Date.now()

  while (true) {
    try {
      const stream = streamText({
        model: provider.chatModel(resolvedModel),
        system: systemPrompt,
        // Seven-pass message preparation before the SDK sees them (mirrors
        // Claude Code's normalizeMessagesForAPI → ensureToolResultPairing
        // pipeline ordering):
        //   1. inlineReasoningAsText — rewrite reasoning blocks as
        //      <thinking> text so the request is portable across stateless
        //      proxies (copilot-api, etc.).
        //   2. expandAttachmentMessagesForAPI — inline attachment records
        //      into meta user messages (history keeps attachment type).
        //   3. regroupToolResults — pull every tool-result back to
        //      immediately follow the assistant that issued its tool-call
        //      (CC's "merge same-turn assistant + hoist tool_results").
        //   4. mergeAdjacentUserMessages — collapse consecutive user
        //      messages (expanded attachments + real prompt).
        //   5. smooshSystemReminderSiblings — fold SR siblings into
        //      simulated tool-result anchors / tool outputs (CC).
        //   6. ensureToolResultPairing — safety net for orphan/missing
        //      tool-results.
        //   7. applyCacheControlBreakpoint — prompt caching marker.
        messages: applyCacheControlBreakpoint(
          ensureToolResultPairing(
            smooshSystemReminderSiblings(
              mergeAdjacentUserMessages(
                regroupToolResults(
                  expandAttachmentMessagesForAPI(inlineReasoningAsText(messages)),
                ),
              ),
            ),
          ),
          provider,
        ) as RoleMessage[],
        // Schema-only tools — execution is handled by toolOrchestration so
        // we can batch concurrency-safe reads in parallel (CC-style).
        tools: apiTools,
        maxOutputTokens: getMaxOutputTokens(),
        maxRetries: 3,
        ...provider.streamTextExtras(),
      })

      const timing = { firstEventMs: 0 }
      const stepResult = await consumeStream(
        stream,
        eventBus,
        timing,
        subagentNames,
        {
          manualToolExecution: true,
        },
      )

      if (stepResult.toolCalls.length > 0) {
        const executed = await runToolCalls({
          toolCalls: stepResult.toolCalls,
          tools: executors,
          eventBus,
          concurrencyPolicy,
          sessionId,
        })
        stepResult.toolResults.push(...executed)
      }

      // Append the SDK's assistant message(s) as-is, then the tool results.
      // We deliberately do NOT reorder here: a reasoning model can split a
      // turn into [assistant(tool-call), assistant(text)], which leaves the
      // tool message non-adjacent to its tool-call. That's repaired at
      // request time by regroupToolResults() (CC's model: keep raw history,
      // normalize only before sending), so assembly stays a dumb append.
      const response = await stream.response
      const sdkMessages = (response.messages as unknown as RoleMessage[]).filter(
        m => m.role !== 'tool',
      )
      sanitizeReasoningParts(sdkMessages)
      // Stamp every assistant record from this response with the round id so
      // they group as one API round (matches CC's per-response message.id),
      // plus a receive timestamp for time-based micro-compaction.
      const roundId = response.id
      const receivedAt = Date.now()
      for (const m of sdkMessages) {
        if (m.role === 'assistant') {
          if (roundId) (m as AssistantMessage).id = roundId
          ;(m as AssistantMessage).timestamp = receivedAt
        }
      }
      messages.push(...sdkMessages)

      if (stepResult.toolResults.length > 0) {
        messages.push(buildToolMessage(stepResult.toolResults))
        for (const tr of stepResult.toolResults) {
          if (tr.followUpMessages?.length) {
            messages.push(...tr.followUpMessages)
          }
        }
      }

      // AI SDK exposes usage as a settled-after-stream promise. Stateless
      // proxies that drop the final SSE event may leave fields undefined.
      let usage: AttachedTokenUsage = {}
      try {
        usage = (await stream.usage) ?? {}
      } catch {
        // Don't fail the step over a missing telemetry counter.
      }
      // Cache real usage onto the last assistant message of this step's
      // response — next step's tokenCountWithEstimation uses it as the
      // precise baseline.
      if (usage.inputTokens != null || usage.totalTokens != null) {
        for (let i = sdkMessages.length - 1; i >= 0; i--) {
          if (sdkMessages[i].role === 'assistant') {
            attachTokenUsage(sdkMessages[i], usage)
            break
          }
        }
      }

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
      })
      return stepResult
    } catch (err) {
      if (ctxLengthAttempt === 0 && isContextLengthError(err)) {
        const errMsg = err instanceof Error ? err.message : String(err)
        console.warn(
          `[agent] step ${step} hit context-length error → reactive aggressive compaction. ${errMsg}`,
        )
        eventBus.emit('compaction_reactive', { error: errMsg })
        const recompacted = await compactIfNeeded(
          messages,
          eventBus,
          resolvedModel,
          cwd ?? process.cwd(),
          args.currentTodos,
          {
            force: true,
            aggressive: true,
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
        continue
      }
      if (
        transientAttempt < MAX_TRANSIENT_RETRIES &&
        isTransientStreamError(err)
      ) {
        transientAttempt++
        // Exponential backoff: 500ms, 1500ms.
        const backoffMs = 500 * Math.pow(3, transientAttempt - 1)
        const errMsg = err instanceof Error ? err.message : String(err)
        console.warn(
          `[agent] step ${step} transient stream error (attempt ${transientAttempt}/${MAX_TRANSIENT_RETRIES}), retrying in ${backoffMs}ms: ${errMsg}`,
        )
        eventBus.emit('transient_retry', {
          attempt: transientAttempt,
          max: MAX_TRANSIENT_RETRIES,
          backoffMs,
          error: errMsg,
        })
        await new Promise(r => setTimeout(r, backoffMs))
        requestStart = Date.now()
        continue
      }
      // Terminal failure: surface to UI, end the agent loop gracefully so
      // the SSE stream closes cleanly and the session stays usable.
      const message = err instanceof Error ? err.message : String(err)
      const cause =
        err instanceof Error && err.cause instanceof Error
          ? ` (${err.cause.message})`
          : ''
      console.error(`[agent] step ${step} failed: ${message}${cause}`)
      eventBus.emit('error', {
        message: `Upstream stream failed: ${message}${cause}. Try again or check your proxy logs.`,
      })
      autoCompleteTodos(args.currentTodos, eventBus)
      eventBus.emit('done', { steps: step + 1 })
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
  console.log(
    `[agent] step ${a.step} done — total=${totalMs}ms ` +
      `(ttfb=${ttfb}ms upstream-wait, gen=${generationMs}ms streaming), ` +
      `usage[${usageParts.join(' ')}], ` +
      `reasoning_blocks=${reasoningCount}, tool_calls=${a.toolCallsLen}, ` +
      `step_total=${Date.now() - a.stepStart}ms` +
      (a.reactiveCompacted ? ', reactive_compaction=yes' : ''),
  )

  // Telemetry: emit a structured usage event. Consumers (server layer) decide
  // whether/where to ship it; core stays free of network + identity concerns.
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
