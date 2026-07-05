import type { ServerResponse } from 'http'
import type {
  Session,
  RunAgentFn,
  Message,
  UserMessage,
  IEventBus,
} from '../core/types.js'
import { EventBus } from '../core/event-bus.js'
import { buildProvider } from '../core/llm/index.js'
import { resolveSettings } from '../core/settings-manager.js'
import { prepareChatTurn } from '../utils/processUserInput/prepare_chat_turn.js'
import { getSystemPromptForMode } from '../prompts/mode.js'
import { applyModeRestrictions } from '../core/mode-restrictions.js'
import { planExists } from '../utils/plans.js'
import { appendMessage, appendCompaction, appendModeChange } from './session.js'
import {
  compactIfNeeded,
  tokenCountWithEstimation,
} from '../services/compact/index.js'
import { defaultRegistry } from '../tools/index.js'
import { Middleware, createTimingMiddleware } from '../core/middleware/index.js'
import { createPlanModeGuardMiddleware } from '../core/middleware/plan-mode-guard.js'
import { applyPluginHooks, hasPluginHooks } from '../core/plugins/index.js'
import { attachUsageTelemetry, flushUsage } from './telemetry.js'
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

export interface RunChatTurnInput {
  message: string
  session: Session
  cwd: string
  runAgent: RunAgentFn
  /** Protocol sink — use noop transport when the client wants buffered JSON. */
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
  /** e.g. req.on('close', cleanup) for SSE disconnect. */
  onClientDisconnect?: (cleanup: () => void) => void
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

/** Buffered JSON responses — wire emits are dropped. */
export function createNoopTransport(): SSETransport {
  return noopTransport
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
  } = input

  const resolvedSettings = resolveSettings(cwd)
  const provider = buildProvider(resolvedSettings.config.provider)
  const wire = createWireEmitter(transport, session.id)

  if (!session.permissionMode) {
    session.permissionMode = { mode: 'agent' }
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
    appendModeChange(session.id, session)
  }

  const eventBus = externalBus ?? new EventBus()
  onClientDisconnect?.(() => eventBus.removeAllListeners())

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

  const prepared = await prepareChatTurn({
    message,
    cwd,
    session,
    registry: defaultRegistry,
    config: resolvedSettings.config,
    provider,
    eventBus,
    middleware,
    runAgent,
  })

  prepared.toolContext.wire = wire

  if (prepared.forkSkill) {
    const streaming = http?.wantsStream ?? true
    await respondSkillFork({
      // SSE: chat route already opened the transport — reuse it.
      res: http && !streaming ? http.res : undefined,
      stdioTransport: streaming ? transport : undefined,
      skill: prepared.forkSkill.entry.def,
      combined: prepared.forkSkill.text,
      cwd,
      runAgent,
      provider,
      config: resolvedSettings.config,
      wantsStream: streaming,
      sseHeaders: http?.sseHeaders,
      sessionId: session.id,
    })
    unsubTelemetry?.()
    void flushUsage()
    if (http?.wantsStream) transport.end()
    return { finalText: '', error: null, reason: 'skill_fork' }
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
        { force: true, instructions: instructions || undefined },
        resolvedSettings.config.compaction,
        provider,
        session.id,
      )
      if (managed !== session.messages && managed.length > 0) {
        session.messages.length = 0
        session.messages.push(...managed)
        appendCompaction(session.id, session.messages)
        const tokensAfter = tokenCountWithEstimation(session.messages).total
        const tokenLine = `~${tokensBefore.toLocaleString()} → ~${tokensAfter.toLocaleString()} tokens`
        if (session.messages.length === 1) {
          replyText =
            `Compacted: ${msgsBefore} → 1 message, ${tokenLine}.` +
            (instructions ? `\nFocus: ${instructions}` : '')
        } else {
          replyText =
            `Partially compacted (full summary unavailable — cleared old tool ` +
            `outputs only): ${msgsBefore} → ${session.messages.length} messages, ${tokenLine}.`
        }
      } else {
        replyText =
          msgsBefore < 2
            ? 'Nothing to compact yet — the conversation is too short.'
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
    return { finalText: replyText, error: null, reason: 'compact' }
  }

  if (prepared.immediateReply !== null) {
    wire.textDelta(prepared.immediateReply)
    wire.finish('slash_command')
    unsubMode()
    unsubTelemetry?.()
    void flushUsage()
    if (transport !== noopTransport) transport.end()
    return {
      finalText: prepared.immediateReply,
      error: null,
      reason: 'slash_command',
    }
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
  const userTurnForDisplay: UserMessage = { role: 'user', content: message }

  const systemPrompt = getSystemPromptForMode(
    session.permissionMode.mode,
    cwd,
    prepared.projectRules || undefined,
    {
      planFilePath: prepared.planFilePath,
      planExists: planExists(session, cwd),
    },
  )

  const refreshTools = () =>
    applyModeRestrictions(
      session.permissionMode.mode,
      prepared.baseTools,
      prepared.modeTools,
    )

  const refreshSystemPrompt = () =>
    getSystemPromptForMode(
      session.permissionMode.mode,
      cwd,
      prepared.projectRules || undefined,
      {
        planFilePath: prepared.planFilePath,
        planExists: planExists(session, cwd),
      },
    )

  try {
    finalText = await runAgent(prepared.effectiveMessage, {
      tools: prepared.tools,
      systemPrompt,
      eventBus,
      wire,
      provider,
      cwd,
      compaction: resolvedSettings.config.compaction,
      messages: session.messages,
      images: images?.length ? images : undefined,
      subagentNames: prepared.subagentNames,
      deferredToolPool: prepared.deferredToolPool,
      concurrencyPolicy: prepared.concurrencyPolicy,
      sessionId: session.id,
      toolUseContext: prepared.toolUseContext,
      refreshTools,
      refreshSystemPrompt,
      onFullCompaction: compactedMessages => {
        appendCompaction(session.id, [...compactedMessages])
        session.messages.push(userTurnForDisplay)
        appendMessage(session.id, userTurnForDisplay)
        persistFrom = session.messages.length
      },
    })
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

  return { finalText, error: runError }
}
