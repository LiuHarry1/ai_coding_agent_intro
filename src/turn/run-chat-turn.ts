/**
 * Transport-agnostic turn host (QueryEngine analogue).
 * HTTP / stdio / ACP adapters call this; persistence still uses server/session.
 */
import type { ServerResponse } from 'http'
import type {
  Session,
  RunAgentFn,
  Message,
  UserMessage,
  IEventBus,
  AgentDefinition,
} from '../core/types.js'
import { buildUserMessage } from '../core/query/helpers.js'
import { offloadChatImageRefs } from '../utils/chat-uploads.js'
import { isAttachmentMessage, isRoleMessage } from '../core/types.js'
import type { ModelRegistry } from '../core/llm/index.js'
import { EventBus } from '../core/event-bus.js'
import { createModelRegistry, resolveSidePathModel } from '../core/llm/index.js'
import { resolveSettings, resolveAutoMemoryConfig } from '../core/settings-manager.js'
import { getDefaultWorkspace } from '../core/workspace.js'
import { isRemoteWorkspace } from '../execution/index.js'
import { generateSessionTitle } from '../services/sessionTitle.js'
import {
  setSessionTitle,
  appendMessage,
  appendCompaction,
  appendModeChange,
} from '../session/index.js'
import { prepareChatTurn } from '../utils/processUserInput/prepare_chat_turn.js'
import { profileSpan } from '../utils/startupProfiler.js'
import { getSystemPromptForMode } from '../prompts/mode.js'
import { getSystemPromptForAgentProfile } from '../prompts/agent-profile.js'
import { applyModeRestrictions } from '../core/mode-restrictions.js'
import { filterToolsRecordByDisallowedGlobs } from '../tools/AgentTool/toolGlob.js'
import { planExists } from '../utils/plans.js'
import { createMemoryLifecycleHooks } from './memory-lifecycle.js'
import {
  getAutoMemPath,
  startRelevantMemoryPrefetch,
} from '../services/auto-memory/index.js'
import {
  compactIfNeeded,
  tokenCountWithEstimation,
} from '../services/compact/index.js'
import {
  extractSessionMemory,
  getSessionMemoryPath,
} from '../services/session-memory/index.js'
import { createCacheSafeParams } from '../core/forked-agent.js'
import { defaultRegistry } from '../tools.js'
import { Middleware, createTimingMiddleware } from '../core/middleware/index.js'
import { createPlanModeGuardMiddleware } from '../core/middleware/plan-mode-guard.js'
import { applyPluginHooks, hasPluginHooks } from '../core/plugins/index.js'
import { attachUsageTelemetry, flushUsage } from '../server/telemetry.js'
import { createWireEmitter } from '../core/wire-emitter.js'
import {
  buildInitMessage,
  modeChangedMessage,
} from '../core/protocol-messages.js'
import {
  handlePlanModeTransition,
  isValidExternalMode,
  transitionPermissionMode,
} from '../core/permission-mode.js'
import type { SSETransport } from '../core/types.js'
import { respondSkillFork } from '../skills/respond-fork.js'
import {
  abortTurn,
  clearTurnAbort,
  registerTurnAbort,
  type TurnAbortReason,
} from '../core/turn-abort-registry.js'

export interface RunChatTurnInput {
  message: string
  session: Session
  cwd: string
  runAgent: RunAgentFn
  /** Protocol sink -- use noop transport when the client wants buffered JSON. */
  transport: SSETransport
  images?: string[]
  mode?: string
  /** When false, skip system/init (multi-turn stdio). Default true. */
  emitHandshake?: boolean
  /** HTTP skill-fork path; omit for stdio CLI. */
  http?: {
    res: ServerResponse
    wantsStream: boolean
    sseHeaders?: Record<string, string>
  }
  /** e.g. res.on('close', cleanup) for premature SSE disconnect. */
  onClientDisconnect?: (cleanup: () => void) => void
  /**
   * External cancel (ACP / POST /chat/cancel). Combined with disconnect into
   * one turn AbortSignal passed to runAgent.
   */
  abortSignal?: AbortSignal
  /** When set, caller owns telemetry/quota subscriptions on this bus. */
  eventBus?: IEventBus
}

export interface RunChatTurnResult {
  finalText: string
  error: Error | null
  reason?: 'compact' | 'slash_command' | 'skill_fork'
}

const noopTransport: SSETransport = {
  emit() {},
  end() {},
}

/**
 * Primary profile REPLACE when in agent mode (overrides default system prompt).
 */
async function resolveTurnSystemPrompt(
  session: Session,
  cwd: string,
  projectRules: string | undefined,
  profile: AgentDefinition | null,
  planOpts: { planFilePath: string; planExists: boolean },
): Promise<string> {
  if (session.permissionMode.mode === 'agent' && profile) {
    return getSystemPromptForAgentProfile(
      profile,
      cwd,
      projectRules,
      session.id,
    )
  }
  return getSystemPromptForMode(
    session.permissionMode.mode,
    cwd,
    projectRules,
    planOpts,
  )
}

/** Buffered JSON responses -- wire emits are dropped. */
export function createNoopTransport(): SSETransport {
  return noopTransport
}

/**
 * Fire-and-forget title generation on the first user turn.
 * Failures keep the heuristic preview from the first message.
 */
function maybeGenerateSessionTitle(
  session: Session,
  message: string,
  models: ModelRegistry,
): void {
  if (session.title?.trim()) return
  const userTurns = session.messages.filter(
    m => isRoleMessage(m) && m.role === 'user',
  ).length
  // Current turn's user message is not yet appended; 0 prior user msgs = first turn.
  if (userTurns !== 0) return
  const text = message.trim()
  if (!text) return

  const small = models.provider('small')
  const modelId = models.profile('small').model
  void generateSessionTitle(text, small, modelId)
    .then(title => {
      if (title) setSessionTitle(session.id, title)
    })
    .catch(() => {})
}

/**
 * Run one user turn and stream `@ai-agent/protocol` messages on `transport`.
 * Shared by HTTP `/chat` (SSE or JSON) and headless stdio CLI.
 */
export async function runChatTurn(
  input: RunChatTurnInput,
): Promise<RunChatTurnResult> {
  const {
    message,
    session,
    cwd,
    runAgent,
    transport,
    images,
    mode,
    emitHandshake = true,
    http,
    eventBus: externalBus,
    onClientDisconnect,
    abortSignal: externalAbort,
  } = input

  const settingsCwd = isRemoteWorkspace(session.workspace)
    ? getDefaultWorkspace()
    : cwd
  const resolvedSettings = resolveSettings(settingsCwd)
  const models = createModelRegistry(resolvedSettings.config.models)
  const provider = models.provider('large')
  const wire = createWireEmitter(transport, session.id)

  if (!session.permissionMode) {
    session.permissionMode = { mode: 'agent' }
  }
  if (session.agentType === undefined) {
    session.agentType = null
  }

  if (
    mode &&
    isValidExternalMode(mode) &&
    mode !== session.permissionMode.mode
  ) {
    const from = session.permissionMode.mode
    handlePlanModeTransition(from, mode, session)
    session.permissionMode = transitionPermissionMode(
      from,
      mode,
      session.permissionMode,
    )
    if (mode === 'ask' || mode === 'plan') {
      session.agentType = null
    }
    appendModeChange(session.id, session)
  }

  const eventBus = externalBus ?? new EventBus()
  const turnAbort = registerTurnAbort(session.id)
  const abortNow = (reason: TurnAbortReason) => {
    abortTurn(session.id, reason)
  }
  if (externalAbort) {
    if (externalAbort.aborted) abortNow('external')
    else
      externalAbort.addEventListener('abort', () => abortNow('external'), {
        once: true,
      })
  }
  onClientDisconnect?.(() => abortNow('disconnect'))

  const finish = <T extends RunChatTurnResult>(result: T): T => {
    clearTurnAbort(session.id, turnAbort)
    return result
  }

  // OpenClaw claim-check: persist bytes under uploads/, keep short URLs in history.
  let imageRefs: string[] | undefined
  try {
    const refs = await offloadChatImageRefs(session.id, images)
    imageRefs = refs.length ? refs : undefined
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    wire.error(msg)
    wire.done()
    if (transport !== noopTransport) transport.end()
    return finish({ finalText: '', error: e as Error })
  }

  let unsubTelemetry: (() => void) | undefined
  if (!externalBus) {
    const telemetryCtx = {
      sessionId: session.id,
      userEmail: session.ownerEmail,
    }
    unsubTelemetry = attachUsageTelemetry(eventBus, telemetryCtx)
  }

  const middleware = new Middleware()
  middleware.use('afterTool', createTimingMiddleware(wire).afterTool)
  middleware.use('beforeTool', createPlanModeGuardMiddleware(session, cwd))
  if (hasPluginHooks()) applyPluginHooks(middleware, eventBus)

  const prepared = await profileSpan('turn_prepare', () =>
    prepareChatTurn({
      message,
      cwd,
      session,
      registry: defaultRegistry,
      config: resolvedSettings.config,
      provider,
      models,
      eventBus,
      middleware,
      runAgent,
    }),
  )

  // Title via small model after the first real user turn.
  maybeGenerateSessionTitle(session, message, models)

  prepared.toolContext.wire = wire

  if (prepared.forkSkill) {
    const streaming = http?.wantsStream ?? true
    await respondSkillFork({
      // SSE: chat route already opened the transport -- reuse it.
      res: http && !streaming ? http.res : undefined,
      stdioTransport: streaming ? transport : undefined,
      skill: prepared.forkSkill.entry.def,
      combined: prepared.forkSkill.text,
      cwd,
      runAgent,
      provider,
      models,
      config: resolvedSettings.config,
      wantsStream: streaming,
      sseHeaders: http?.sseHeaders,
      sessionId: session.id,
    })
    unsubTelemetry?.()
    void flushUsage()
    if (http?.wantsStream) transport.end()
    return finish({ finalText: '', error: null, reason: 'skill_fork' })
  }

  if (emitHandshake && transport !== noopTransport) {
    wire.emit(
      buildInitMessage({
        session_id: session.id,
        permission_mode: session.permissionMode.mode,
        cwd,
      }),
    )
    wire.emit(
      modeChangedMessage(session.permissionMode.mode, {
        session_id: session.id,
      }),
    )
  }

  if (prepared.modeChanged) {
    appendModeChange(session.id, session)
    wire.emit(
      modeChangedMessage(session.permissionMode.mode, {
        session_id: session.id,
      }),
    )
  }

  const unsubMode = eventBus.on('mode_changed', data => {
    const newMode = (data as { mode: string }).mode
    if (newMode && isValidExternalMode(newMode)) {
      appendModeChange(session.id, session)
      wire.emit(modeChangedMessage(newMode, { session_id: session.id }))
    }
  })

  if (prepared.manualCompact) {
    const instructions = prepared.manualCompact.instructions.trim()
    const msgsBefore = session.messages.length
    const tokensBefore = tokenCountWithEstimation(session.messages).total
    let replyText: string
    try {
      const model = provider.defaultModelId()
      const managed = await compactIfNeeded(
        session.messages,
        eventBus,
        wire,
        model,
        cwd,
        [],
        {
          force: true,
          instructions: instructions || undefined,
          sessionMemory: resolvedSettings.config.sessionMemory,
          readFileState: session.readFileState as
            | import('../utils/read/types.js').ReadFileState
            | undefined,
        },
        resolvedSettings.config.compaction,
        provider,
        session.id,
      )
      if (managed !== session.messages && managed.length > 0) {
        session.messages.length = 0
        session.messages.push(...managed)
        appendCompaction(session.id, session.messages)
        const tokensAfter = tokenCountWithEstimation(session.messages).total
        const tokenLine = `~${tokensBefore.toLocaleString()} -> ~${tokensAfter.toLocaleString()} tokens`
        const kept = session.messages.filter(
          m => !(isRoleMessage(m) && m.role === 'user' && m.isCompactSummary),
        ).length
        replyText =
          `Compacted: ${msgsBefore} -> ${session.messages.length} messages` +
          ` (kept ${kept} recent), ${tokenLine}.` +
          (instructions ? `\nFocus: ${instructions}` : '')
      } else {
        replyText =
          msgsBefore < 2
            ? 'Nothing to compact yet -- the conversation is too short.'
            : 'Compaction did not reduce the conversation (summarizer returned no change).'
      }
    } catch (e) {
      replyText = `Compaction failed: ${(e as Error).message}`
    }

    wire.textDelta(replyText)
    wire.finish('compact')
    unsubMode()
    unsubTelemetry?.()
    void flushUsage()
    if (transport !== noopTransport) transport.end()
    return finish({ finalText: replyText, error: null, reason: 'compact' })
  }

  if (prepared.forceSummary) {
    const sm = resolvedSettings.config.sessionMemory
    let replyText: string
    if (!sm.enabled) {
      replyText = 'Session memory is disabled in settings.'
    } else {
      const systemPrompt = await resolveTurnSystemPrompt(
        session,
        cwd,
        prepared.projectRules || undefined,
        prepared.mainThreadProfile,
        {
          planFilePath: prepared.planFilePath,
          planExists: planExists(session, cwd),
        },
      )
      const mainModelId = models.profile('large').model
      const side = resolveSidePathModel({
        models,
        cacheSafe: sm.cacheSafe,
        modelTier: sm.modelTier,
        mainProvider: provider,
        mainModelId,
      })
      const cacheSafeParams = side.cacheSafe
        ? createCacheSafeParams({
            systemPrompt,
            tools: prepared.tools,
            provider: side.provider,
            model: side.modelId,
            messages: session.messages,
          })
        : undefined
      const result = await extractSessionMemory({
        messages: session.messages,
        sessionId: session.id,
        provider: side.provider,
        modelId: side.modelId,
        config: sm,
        force: true,
        runAgent,
        cwd,
        cacheSafeParams,
      })
      const memPath = getSessionMemoryPath(session.id)
      replyText = result.ok
        ? `Session memory updated.\n${memPath}`
        : `Session memory update skipped: ${result.error ?? 'unknown'}`
    }
    wire.textDelta(replyText)
    wire.finish('slash_command')
    unsubMode()
    unsubTelemetry?.()
    void flushUsage()
    if (transport !== noopTransport) transport.end()
    return finish({
      finalText: replyText,
      error: null,
      reason: 'slash_command',
    })
  }

  if (prepared.immediateReply !== null) {
    wire.textDelta(prepared.immediateReply)
    wire.finish('slash_command')
    unsubMode()
    unsubTelemetry?.()
    void flushUsage()
    if (transport !== noopTransport) transport.end()
    return finish({
      finalText: prepared.immediateReply,
      error: null,
      reason: 'slash_command',
    })
  }

  const unsubDiscover = eventBus.on('tools_discovered', data => {
    const names = (data as { tools: string[] }).tools
    if (!session.discoveredTools) session.discoveredTools = new Set()
    for (const n of names) session.discoveredTools.add(n)
  })

  const messagesBefore = session.messages.length
  let persistFrom = messagesBefore
  let finalText = ''
  let runError: Error | null = null
  const userTurnForDisplay: UserMessage = buildUserMessage(message, imageRefs)

  const systemPrompt = await resolveTurnSystemPrompt(
    session,
    cwd,
    prepared.projectRules || undefined,
    prepared.mainThreadProfile,
    {
      planFilePath: prepared.planFilePath,
      planExists: planExists(session, cwd),
    },
  )

  const refreshTools = () => {
    const next = applyModeRestrictions(
      session.permissionMode.mode,
      prepared.baseTools,
      prepared.modeTools,
    )
    return filterToolsRecordByDisallowedGlobs(next, prepared.denyGlobs)
  }

  const refreshSystemPrompt = () =>
    resolveTurnSystemPrompt(
      session,
      cwd,
      prepared.projectRules || undefined,
      // Mid-turn mode change to ask/plan clears agentType; drop profile prompt.
      session.permissionMode.mode === 'agent' && session.agentType
        ? prepared.mainThreadProfile
        : null,
      {
        planFilePath: prepared.planFilePath,
        planExists: planExists(session, cwd),
      },
    )

  try {
    const mainModelId = models.profile('large').model
    const sessionMemorySide = resolveSidePathModel({
      models,
      cacheSafe: resolvedSettings.config.sessionMemory.cacheSafe,
      modelTier: resolvedSettings.config.sessionMemory.modelTier,
      mainProvider: provider,
      mainModelId,
    })
    const autoMemoryConfig = resolveAutoMemoryConfig(resolvedSettings.config)
    const autoMemorySide = resolveSidePathModel({
      models,
      cacheSafe: autoMemoryConfig.cacheSafe,
      modelTier: autoMemoryConfig.modelTier,
      mainProvider: provider,
      mainModelId,
      defaultTier: 'medium',
    })
    const prefetchSide = resolveSidePathModel({
      models,
      cacheSafe: false,
      modelTier: autoMemoryConfig.prefetchModelTier,
      mainProvider: provider,
      mainModelId,
      defaultTier: 'small',
    })
    const memoryHooks = createMemoryLifecycleHooks({
      sessionMemory: resolvedSettings.config.sessionMemory,
      sessionMemoryModelId: sessionMemorySide.modelId,
      sessionMemoryProvider: sessionMemorySide.provider,
      autoMemory: autoMemoryConfig,
      autoMemoryModelId: autoMemorySide.modelId,
      autoMemoryProvider: autoMemorySide.provider,
      compactionEnabled: resolvedSettings.config.compaction?.enabled !== false,
      runAgent,
    })

    const remote = isRemoteWorkspace(session.workspace)
    const memPath =
      autoMemoryConfig.enabled &&
      !remote &&
      autoMemoryConfig.prefetchEnabled !== false
        ? getAutoMemPath({
            cwd,
            trustedDirectory: autoMemoryConfig.directory,
          })
        : undefined

    const memoryPrefetch =
      memPath != null
        ? startRelevantMemoryPrefetch(session.messages, {
            config: autoMemoryConfig,
            memPath,
            provider: prefetchSide.provider,
            modelId: prefetchSide.modelId,
            readFileState: prepared.toolUseContext.readFileState,
            queryText: prepared.effectiveMessage,
          })
        : undefined

    try {
      finalText = await runAgent(prepared.effectiveMessage, {
        tools: prepared.tools,
        systemPrompt,
        eventBus,
        wire,
        provider,
        cwd,
        compaction: resolvedSettings.config.compaction,
        sessionMemory: resolvedSettings.config.sessionMemory,
        messages: session.messages,
        images: imageRefs,
        subagentNames: prepared.subagentNames,
        deferredToolPool: prepared.deferredToolPool,
        getToolDefinition: prepared.getToolDefinition,
        concurrencyPolicy: prepared.concurrencyPolicy,
        sessionId: session.id,
        toolUseContext: prepared.toolUseContext,
        refreshTools,
        refreshSystemPrompt,
        memoryPrefetch,
        abortSignal: turnAbort.signal,
        onAfterStep: memoryHooks.onAfterStep,
        onTurnEnd: memoryHooks.onTurnEnd,
        onFullCompaction: compactedMessages => {
          const checkpoint = compactedMessages.filter(
            m => !isAttachmentMessage(m),
          )
          appendCompaction(session.id, checkpoint)
          session.messages.push(userTurnForDisplay)
          appendMessage(session.id, userTurnForDisplay)
          persistFrom = session.messages.length
        },
      })
    } finally {
      memoryPrefetch?.dispose()
    }
  } catch (e) {
    runError = e as Error
  } finally {
    unsubDiscover()
    unsubMode()
    unsubTelemetry?.()
    void flushUsage()
  }

  for (const msg of session.messages.slice(persistFrom)) {
    appendMessage(session.id, msg as Message)
  }

  if (runError) wire.error(runError.message)
  wire.done()
  if (transport !== noopTransport) transport.end()

  return finish({ finalText, error: runError })
}
