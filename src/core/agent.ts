import { streamText } from 'ai'
import {
  attachTokenUsage,
  compactIfNeeded,
  tokenCountWithEstimation,
} from '../services/compact/index.js'
import type { AttachedTokenUsage, CompactEnrichment } from '../services/compact/index.js'
import {
  ensureMessageUuid,
  ensureMessageUuids,
} from '../services/session-memory/index.js'
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
  projectMessagesForApi,
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
import { consumeMemoryPrefetchIfReady } from '../services/auto-memory/prefetch.js'
import { consumeStream, type StreamResult } from './agent/streamConsumer.js'
import { emitTodoUpdate } from './wire-internal.js'
import type { WireEmitter } from './wire-emitter.js'
import { stripToolExecute } from './agent/prepareTools.js'
import { extractPartialResult } from '../tools/AgentTool/finalizeAgentTool.js'
import {
  buildToolMessage,
  runToolCalls,
} from '../services/tools/tool_execution.js'
import {
  appendUserInterruption,
  commitPartialStreamToHistory,
  finalizeInterruptedTurn,
} from '../utils/interrupt.js'
import { abortReasonFromSignal } from './turn-abort-registry.js'
import {
  createDumpPromptsRecorder,
  createNoopDumpPromptsRecorder,
  isDumpPromptsEnabled,
  toolsForDump,
  type DumpPromptsRecorder,
} from '../services/api/dumpPrompts.js'
import {
  BASH_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
  TOOL_SEARCH_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from '../constants/tool_names.js'
import type { ConcurrencyPolicyFn } from './concurrency-policy.js'
import type { AnyTool } from './types.js'

/**
 * Default per-step output cap. 128k used to be sent as `max_tokens`, which
 * LiteLLM counts against the context window (input + max_tokens). A 134k
 * prompt + 128k reservation overflows a 262k model even though the prompt
 * itself still fits.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 16_384

/** Default / resolve console tag: `[agent:main]` or `[agent:session_memory]`. */
function agentLogTag(logLabel?: string): string {
  return `agent:${logLabel ?? 'main'}`
}

function getMaxOutputTokens(): number {
  const parsed = parseInt(process.env.AGENT_MAX_OUTPUT_TOKENS ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_OUTPUT_TOKENS
}

/** Providers reject when prompt tokens + max_tokens exceed the model window. */
function capMaxOutputTokens(
  promptTokens: number,
  contextWindow?: number,
): number {
  const wanted = getMaxOutputTokens()
  const window = contextWindow && contextWindow > 0 ? contextWindow : 200_000
  const remaining = window - promptTokens - 1_024
  return Math.max(1_024, Math.min(wanted, remaining))
}

// ── User-message helpers ────────────────────────────

function parseDataUrl(dataUrl: string): { buffer: Buffer; mediaType: string } {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) throw new Error('Invalid data URL')
  return { mediaType: match[1], buffer: Buffer.from(match[2], 'base64') }
}

function buildUserMessage(text: string, images?: string[]): UserMessage {
  if (!images || images.length === 0) {
    return ensureMessageUuid({ role: 'user', content: text })
  }
  const parts: UserContentPart[] = [{ type: 'text', text }]
  for (const dataUrl of images) {
    const { buffer, mediaType } = parseDataUrl(dataUrl)
    parts.push({ type: 'image', image: buffer, mediaType })
  }
  return ensureMessageUuid({ role: 'user', content: parts })
}

// ── Todo helpers ────────────────────────────────────

function autoCompleteTodos(
  todos: TodoItem[],
  eventBus: AgentOptions['eventBus'],
  wire: WireEmitter,
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
  emitTodoUpdate(wire, eventBus, updated)
}

function formatTodoReminder(todos: TodoItem[]): string {
  const lines = todos.map(t => `- [${t.status}] ${t.id}: ${t.content}`)
  return `[Active todo list -- update via ${TODO_WRITE_TOOL_NAME}(merge=true) as you complete items]\n${lines.join('\n')}`
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
  if (
    !last ||
    !isRoleMessage(last) ||
    last.role !== 'assistant' ||
    !Array.isArray(last.content)
  )
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

    const prefixed = trimmed.toLowerCase().startsWith('select:')
    const rest = prefixed ? trimmed.slice(7) : trimmed
    const commaParts = rest
      .split(',')
      .map(n => n.trim())
      .filter(Boolean)
    if (
      prefixed ||
      (commaParts.length > 1 && commaParts.some(n => n in pool))
    ) {
      names = commaParts
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

/** Plan approved -- any of these in the same turn counts as implementation started. */
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
    wire,
    messages = [],
    images,
    maxSteps,
    model,
    subagentNames,
    deferredToolPool,
    getToolDefinition,
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
  }: AgentOptions,
): Promise<string> {
  if (toolUseContext) {
    for await (const att of getAttachmentMessages(
      userMessage,
      toolUseContext,
      messages,
    )) {
      messages.push(ensureMessageUuid(att))
    }
  }
  messages.push(buildUserMessage(userMessage, images))
  ensureMessageUuids(messages)

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

  // Only enforce a turn cap when maxSteps/maxTurns is provided.
  const stepLimit =
    typeof maxSteps === 'number' && maxSteps > 0
      ? maxSteps
      : Number.POSITIVE_INFINITY

  // CC query.ts: create dump recorder once per agent run (not per step).
  const dumpKey = logLabel
    ? `${sessionId ?? 'unknown'}__${logLabel}`
    : (sessionId ?? 'unknown')
  const dumpPrompts: DumpPromptsRecorder = isDumpPromptsEnabled()
    ? createDumpPromptsRecorder(dumpKey)
    : createNoopDumpPromptsRecorder()

  try {
    for (let step = 0; step < stepLimit; step++) {
      if (abortSignal?.aborted) {
        return finalizeInterruptedTurn(messages, wire, {
          toolUse: false,
          finalText,
          signal: abortSignal,
        })
      }
      wire.stepStart(step)
      const stepStart = Date.now()

      await runCompactionAndLog(
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
        toolUseContext?.readFileState,
      )

      if (abortSignal?.aborted) {
        return finalizeInterruptedTurn(messages, wire, {
          toolUse: false,
          finalText,
          signal: abortSignal,
        })
      }

      const stepResult = await runOneStep({
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
          return finalizeInterruptedTurn(messages, wire, {
            toolUse: false,
            finalText,
            signal: abortSignal,
          })
        }
        // Prefer text from history if the step failed
        // after partial assistant output was already appended.
        return extractPartialResult(messages) ?? finalText
      }

      // Stream aborted mid-turn: partial already committed + interrupt appended
      // inside runOneStep (CC aborted_streaming).
      if (stepResult.aborted) {
        return (
          extractPartialResult(messages) ??
          (finalText || stepResult.text || '')
        )
      }

      // CC post-tools consume: only if settled — never block first API call.
      try {
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
      } catch (e) {
        console.warn(
          `[${agentLogTag(logLabel)}] memory prefetch consume failed: ${
            e instanceof Error ? e.message : e
          }`,
        )
      }

      if (sessionId && onAfterStep) {
        onAfterStep({
          messages,
          systemPrompt: activeSystemPrompt,
          tools: activeTools,
          provider,
          model: resolvedModel,
          sessionId,
          cwd,
        })
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
        // Turn-end host hook (e.g. auto-memory). Never awaited.
        if (sessionId && onTurnEnd) {
          onTurnEnd({
            messages,
            systemPrompt: activeSystemPrompt,
            tools: activeTools,
            provider,
            model: resolvedModel,
            sessionId,
            cwd,
          })
        }
        autoCompleteTodos(currentTodos, eventBus, wire)
        wire.done()
        // If last turn was tool_use-only, walk back for earlier text.
        return extractPartialResult(messages) ?? finalText
      }

      if (toolUseContext) {
        for await (const att of getAttachmentMessages(
          null,
          toolUseContext,
          messages,
        )) {
          messages.push(ensureMessageUuid(att))
        }
      }

      wire.thinking()
    }

    // Finite maxSteps exhausted (stop + salvage; same as common agent-loop
    // pattern A: one extra toolless turn so the parent always gets a report).
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
    }
    wire.done()
    return text
  } finally {
    unsubPlanReady()
    unsubMode()
    unsubTodo()
  }
}

/**
 * Haystack / Livekit / Hermes pattern: after the step budget is spent, make
 * one more LLM call with no tools (`toolChoice: 'none'`) so the model must
 * emit a text summary. Does not count toward maxSteps.
 */
async function forceFinalAnswerOnMaxSteps(input: {
  messages: Message[]
  systemPrompt: string
  provider: IProvider
  resolvedModel: string
  eventBus: AgentOptions['eventBus']
  wire: WireEmitter
  step: number
  currentTodos: TodoItem[]
  cwd?: string
  compaction?: AgentOptions['compaction']
  sessionMemory?: AgentOptions['sessionMemory']
  sessionId?: string
  onFullCompaction?: AgentOptions['onFullCompaction']
  compactEnrichment?: CompactEnrichment
}): Promise<string> {
  input.messages.push(
    ensureMessageUuid({
      role: 'user',
      content: `<system-reminder>
You have reached the maximum number of agent steps (${input.step}).
Tool-calling budget is exhausted. Write a clear, self-contained final report of
what you learned and accomplished so far. Respond in plain text / markdown only
— do not call any tools.
</system-reminder>`,
    }),
  )
  input.wire.stepStart(input.step)
  const stepStart = Date.now()
  try {
    const stepResult = await runOneStep({
      messages: input.messages,
      tools: {},
      toolChoice: 'none',
      systemPrompt: input.systemPrompt,
      provider: input.provider,
      resolvedModel: input.resolvedModel,
      eventBus: input.eventBus,
      wire: input.wire,
      step: input.step,
      stepStart,
      currentTodos: input.currentTodos,
      concurrencyPolicy: () => false,
      cwd: input.cwd,
      compaction: input.compaction,
      sessionMemory: input.sessionMemory,
      sessionId: input.sessionId,
      onFullCompaction: input.onFullCompaction,
      compactEnrichment: input.compactEnrichment,
    })
    const fromStep = stepResult?.text?.trim() ?? ''
    if (fromStep) return fromStep
    // Model may still have emitted text only in history (or ignored toolChoice).
    return extractPartialResult(input.messages) ?? ''
  } catch (err) {
    console.warn(`[agent] forceFinalAnswerOnMaxSteps failed: ${err}`)
    return extractPartialResult(input.messages) ?? ''
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
  wire: WireEmitter,
  step: number,
  resolvedModel: string,
  provider: IProvider,
  currentTodos: TodoItem[],
  cwd?: string,
  compaction?: AgentOptions['compaction'],
  sessionMemory?: AgentOptions['sessionMemory'],
  sessionId?: string,
  onFullCompaction?: AgentOptions['onFullCompaction'],
  compactEnrichment?: CompactEnrichment,
  logLabel?: string,
  readFileState?: import('../utils/attachments/types.js').ReadFileState,
): Promise<void> {
  const compactStart = Date.now()
  const managed = await compactIfNeeded(
    messages,
    eventBus,
    wire,
    resolvedModel,
    cwd ?? process.cwd(),
    currentTodos,
    {
      enrichment: compactEnrichment,
      sessionMemory,
      readFileState,
    },
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
  const tag = agentLogTag(logLabel)
  console.log(
    `[${tag}] step ${step} start -- ${messages.length} msgs, ${tokenLabel}, ` +
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
  /** AI SDK toolChoice — use `'none'` for the maxSteps final-answer turn. */
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
  cwd?: string
  compaction?: AgentOptions['compaction']
  sessionMemory?: AgentOptions['sessionMemory']
  sessionId?: string
  onFullCompaction?: AgentOptions['onFullCompaction']
  compactEnrichment?: CompactEnrichment
  logLabel?: string
  abortSignal?: AbortSignal
  readFileState?: import('../utils/attachments/types.js').ReadFileState
  /** CC dump-prompts recorder (one per runAgent). */
  dumpPrompts?: DumpPromptsRecorder
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

  while (true) {
    try {
      // Final API-bound messages (same array streamText receives).
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

      // CC dumpRequest equivalent — async; does not block TTFB.
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
        // Seven-pass message preparation before the SDK sees them:
        //   1. inlineReasoningAsText -- rewrite reasoning blocks as
        //      <thinking> text so the request is portable across stateless
        //      proxies (copilot-api, etc.).
        //   2. expandAttachmentMessagesForAPI -- inline attachment records
        //      into meta user messages (history keeps attachment type).
        //   3. regroupToolResults -- pull every tool-result back to
        //      immediately follow the assistant that issued its tool-call.
        //   4. mergeAdjacentUserMessages -- collapse consecutive user
        //      messages (expanded attachments + real prompt).
        //   5. smooshSystemReminderSiblings -- fold SR siblings into
        //      simulated tool-result anchors / tool outputs.
        //   6. ensureToolResultPairing -- safety net for orphan/missing
        //      tool-results.
        //   7. projectMessagesForApi -- drop toolUseResult (UI envelope) and,
        //      on providers without multimodal tool results, relocate
        //      tool-result images into a following user message.
        //   8. applyCacheControlBreakpoint -- prompt caching marker.
        messages: apiMessages,
        // Schema-only tools -- execution is handled by toolOrchestration so
        // we can batch concurrency-safe reads in parallel.
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

      const timing = { firstEventMs: 0 }
      const stepResult = await consumeStream(
        stream,
        wire,
        timing,
        subagentNames,
        {
          manualToolExecution: true,
        },
      )

      // CC aborted_streaming: salvage partial text/tool_use, fill missing
      // tool_results, append [Request interrupted by user], stop the turn.
      if (stepResult.aborted) {
        commitPartialStreamToHistory(messages, stepResult, wire)
        // Streaming-abort interrupt uses the non-tool-use marker (CC), even
        // when some tool_use blocks were already emitted.
        appendUserInterruption(messages, wire, {
          toolUse: false,
          signal: abortSignal,
        })
        return { ...stepResult, aborted: true, toolCalls: [], toolResults: [] }
      }

      if (stepResult.toolCalls.length > 0) {
        const executed = await runToolCalls({
          toolCalls: stepResult.toolCalls,
          tools: executors,
          wire,
          concurrencyPolicy,
          sessionId,
          logLabel,
          getDefinition: getToolDefinition,
          abortSignal,
        })
        stepResult.toolResults.push(...executed)
      }

      // Append the SDK's assistant message(s) as-is, then the tool results.
      // We deliberately do NOT reorder here: a reasoning model can split a
      // turn into [assistant(tool-call), assistant(text)], which leaves the
      // tool message non-adjacent to its tool-call. That's repaired at
      // request time by regroupToolResults() -- keep raw history, normalize
      // only before sending -- so assembly stays a dumb append.
      const response = await stream.response
      const sdkMessages = (
        response.messages as unknown as RoleMessage[]
      ).filter(m => m.role !== 'tool')
      sanitizeReasoningParts(sdkMessages)
      // Stamp every assistant record from this response with the round id so
      // they group as one API round, plus a receive timestamp for
      // time-based micro-compaction.
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

      // CC aborted_tools: tools finished (or were cancelled with synthetic
      // results); append the tool-use interrupt marker and stop.
      if (abortSignal?.aborted) {
        appendUserInterruption(messages, wire, {
          toolUse: true,
          signal: abortSignal,
        })
        return { ...stepResult, aborted: true }
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
      // response -- next step's tokenCountWithEstimation uses it as the
      // precise baseline.
      if (usage.inputTokens != null || usage.totalTokens != null) {
        for (let i = sdkMessages.length - 1; i >= 0; i--) {
          if (sdkMessages[i].role === 'assistant') {
            attachTokenUsage(sdkMessages[i], usage)
            break
          }
        }
      }

      // CC dumpResponse equivalent — assistant content + usage for this call.
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
        continue
      }
      // Terminal failure: surface to UI, end the agent loop gracefully so
      // the SSE stream closes cleanly and the session stays usable.
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
