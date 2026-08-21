import { randomUUID } from 'crypto'
import type { IncomingMessage, ServerResponse } from 'http'
import {
  createSession,
  getSession,
  canAccessSession,
  tryBeginTurn,
  endTurn,
} from '../session.js'
import { createSSETransport } from '../sse-transport.js'
import { readBody, sendJSON, wantsStreamingResponse } from '../http.js'
import { sessionToUIMessages } from '../session-ui.js'
import { resolveRequestCwd } from '../request-cwd.js'
import type { AuthedRequest } from '../auth/identity.js'
import { EventBus } from '../../core/event-bus.js'
import {
  attachUsageTelemetry,
  flushUsage,
  reportUserQuestion,
} from '../telemetry.js'
import {
  checkQuota,
  commitQuota,
  shouldEnforceQuota,
  trackTurnTokens,
} from '../quota.js'
import {
  handlePlanModeTransition,
  isValidExternalMode,
  transitionPermissionMode,
} from '../../core/permission-mode.js'
import { appendModeChange, appendAgentChange } from '../session.js'
import type { Message, RunAgentFn } from '../../core/types.js'
import { createNoopTransport, runChatTurn } from '../../turn/run-chat-turn.js'
import { loadWorkspaceContributions } from '../../core/workspace-load.js'
import { findPrimaryAgent } from '../../tools/AgentTool/mergeAgents.js'
import { normalizeWorkspacePath } from '../../core/workspace-path.js'

export async function handleChat(
  req: IncomingMessage,
  res: ServerResponse,
  runAgent: RunAgentFn,
): Promise<void> {
  let body: Record<string, unknown>
  try {
    body = await readBody(req)
  } catch {
    sendJSON(res, 400, { error: 'Invalid JSON' })
    return
  }

  const { message, workspace, session_id, images, mode, agentType, environmentId } =
    body as {
      message?: string
      workspace?: string
      session_id?: string
      images?: string[]
      mode?: string
      agentType?: string | null
      /** Optional: bind/use execution environment (default local). */
      environmentId?: string
    }
  if (!message) {
    sendJSON(res, 400, { error: "Missing 'message' field" })
    return
  }

  const wantsStream = wantsStreamingResponse(req, body)

  const requesterEmail = (req as AuthedRequest).user?.email
  let session
  if (session_id) {
    session = getSession(session_id)
    if (
      !session ||
      !canAccessSession(
        session,
        requesterEmail,
        (req as AuthedRequest).user?.role,
      )
    ) {
      sendJSON(res, 404, { error: `Session not found: ${session_id}` })
      return
    }
  }

  // Resolve cwd from Session.workspace handle when present; else legacy path.
  let cwd: string
  if (session?.workspace) {
    cwd = normalizeWorkspacePath(session.workspace.cwd)
  } else {
    cwd = resolveRequestCwd(req, workspace)
  }

  if (!session) {
    session = createSession(requesterEmail)
  }

  // Bind WorkspaceHandle when missing.
  if (!session.workspace) {
    const envId =
      typeof environmentId === 'string' && environmentId.length > 0
        ? environmentId
        : 'local'
    const bindCwd =
      typeof workspace === 'string' && workspace.length > 0 ? workspace : cwd
    if (envId !== 'local') {
      // Remote: require an absolute-looking remote path from the picker.
      if (!bindCwd || bindCwd.includes('\\') || (!bindCwd.startsWith('/') && !bindCwd.startsWith('~'))) {
        sendJSON(res, 400, {
          error:
            'Remote workspace not bound. Use Remote picker to connect and Open Folder first.',
        })
        return
      }
    }
    const { setSessionWorkspace } = await import('../session.js')
    setSessionWorkspace(session.id, {
      environmentId: envId,
      cwd: normalizeWorkspacePath(bindCwd),
    })
    cwd = normalizeWorkspacePath(bindCwd)
  } else {
    cwd = normalizeWorkspacePath(session.workspace.cwd)
  }

  // One turn per session. A duplicate send while a slow step (e.g. full
  // compaction) is running must not spawn a concurrent run over the same
  // message history — that's how repeated compact boundaries pile up.
  if (!tryBeginTurn(session.id)) {
    sendJSON(res, 409, {
      error:
        'A previous message is still being processed for this session ' +
        '(possibly compacting context). Please wait for it to finish.',
      session_id: session.id,
    })
    return
  }

  try {
    await handleChatLocked(req, res, runAgent, session, {
      message,
      images,
      mode,
      agentType: agentType === undefined ? undefined : agentType,
      wantsStream,
      cwd,
      requesterEmail,
    })
  } finally {
    endTurn(session.id)
  }
}

/** The per-session turn mutex is held for the duration of this function. */
async function handleChatLocked(
  req: IncomingMessage,
  res: ServerResponse,
  runAgent: RunAgentFn,
  session: NonNullable<ReturnType<typeof getSession>>,
  opts: {
    message: string
    images?: string[]
    mode?: string
    agentType?: string | null
    wantsStream: boolean
    cwd: string
    requesterEmail?: string
  },
): Promise<void> {
  const { message, images, mode, agentType, wantsStream, cwd, requesterEmail } =
    opts

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

  // Sync main-thread profile from client (before session exists, or on resume).
  if (agentType !== undefined && (mode === undefined || mode === 'agent')) {
    const nextType =
      agentType === null || agentType === '' ? null : String(agentType)
    if (nextType !== (session.agentType ?? null)) {
      if (nextType !== null) {
        const { agents } = await loadWorkspaceContributions(cwd)
        const profile = findPrimaryAgent(agents.activeAgents, nextType)
        if (profile) {
          session.agentType = nextType
          if (session.permissionMode.mode !== 'agent') {
            const from = session.permissionMode.mode
            handlePlanModeTransition(from, 'agent', session)
            session.permissionMode = transitionPermissionMode(
              from,
              'agent',
              session.permissionMode,
            )
          }
          appendAgentChange(session.id, session)
        }
      } else {
        session.agentType = null
        appendAgentChange(session.id, session)
      }
    }
  }

  // Preview: collapse newlines to keep one log entry per line, and slice by
  // code points (not UTF-16 units) so a wide char is never cut in half.
  const preview = [...message.replace(/\s+/g, ' ')].slice(0, 80).join('')
  console.log(
    `[server] chat [session:${session.id.slice(0, 8)}] [mode:${session.permissionMode.mode}] [${session.messages.length} prior msgs] ${preview}`,
  )

  const eventBus = new EventBus()
  const telemetryCtx = {
    sessionId: session.id,
    userEmail: session.ownerEmail,
  }
  const requesterRole = (req as AuthedRequest).user?.role
  const quotaUser = session.ownerEmail ?? requesterEmail
  const quotaEventId = `${session.id}:chat:${randomUUID()}`
  const turnUsage = { tokens: 0 }
  const unsubTurnTokens = trackTurnTokens(eventBus, turnUsage)

  const finishQuota = async (): Promise<void> => {
    unsubTurnTokens()
    if (shouldEnforceQuota(quotaUser, requesterRole)) {
      try {
        await commitQuota(quotaUser!, turnUsage.tokens, quotaEventId)
      } catch (err) {
        console.warn(`[quota] commit failed: ${(err as Error).message}`)
      }
    }
  }

  if (shouldEnforceQuota(quotaUser, requesterRole)) {
    try {
      const q = await checkQuota(quotaUser!)
      if (q.exceeded) {
        unsubTurnTokens()
        sendJSON(res, 429, {
          error: 'Daily token limit exceeded',
          quota: q,
        })
        return
      }
    } catch (err) {
      console.warn(`[quota] status check failed: ${(err as Error).message}`)
    }
  }

  reportUserQuestion(telemetryCtx, session.messages.length, message)
  const unsubTelemetry = attachUsageTelemetry(eventBus, telemetryCtx)

  const sseHeaders: Record<string, string> = {
    'X-Session-Id': session.id,
    'X-Permission-Mode': session.permissionMode.mode,
    'X-Agent-Type': session.agentType ?? '',
  }

  const transport = wantsStream
    ? createSSETransport(res, sseHeaders)
    : createNoopTransport()

  const messagesBefore = session.messages.length

  try {
    const result = await runChatTurn({
      message,
      session,
      cwd,
      runAgent,
      transport,
      images,
      mode,
      eventBus,
      http: { res, wantsStream, sseHeaders },
      onClientDisconnect: cleanup => {
        res.on('close', () => {
          // Normal end also fires close; only abort when the client dropped
          // the stream before we finished writing.
          if (!res.writableEnded) {
            console.log('[server] client disconnected')
            cleanup()
          }
        })
      },
    })

    await finishQuota()
    void flushUsage()

    if (wantsStream || result.reason === 'skill_fork') {
      return
    }

    if (result.error) {
      sendJSON(res, 500, {
        session_id: session.id,
        mode: session.permissionMode.mode,
        error: result.error.message,
      })
      return
    }

    sendJSON(res, 200, {
      session_id: session.id,
      mode: session.permissionMode.mode,
      text: result.finalText,
      reason: result.reason,
      messages: sessionToUIMessages(
        session.messages.slice(messagesBefore) as Message[],
      ),
    })
  } finally {
    unsubTelemetry()
  }
}
