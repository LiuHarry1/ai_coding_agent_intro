import * as fs from 'fs'
import * as path from 'path'
import type { IncomingMessage, ServerResponse } from 'http'
import { createWorkspaceRouter } from './workspace/router.js'
import { createSkillsApi } from './skills-api.js'
import { getDefaultWorkspace } from '../core/workspace.js'
import { defaultRegistry } from '../tools/index.js'
import { registerBuiltinSubagents } from '../tools/AgentTool/index.js'
import { listSlashCommands } from '../commands/dispatcher.js'
import { loadPluginsOverview } from '../commands/slashRegistry.js'
import { answerQuestion } from '../core/brokers/question-broker.js'
import { answerPlanApproval } from '../core/brokers/plan-approval-broker.js'
import {
  handlePlanModeTransition,
  isValidExternalMode,
  transitionPermissionMode,
} from '../core/permission-mode.js'
import { getPlanFilePath } from '../utils/plans.js'
import { readBody, sendJSON, setCORS } from './http.js'
import {
  authenticateRequest,
  isAuthEnabled,
  isSuperUser,
  AuthError,
  type AuthedRequest,
} from './auth/identity.js'
import { serveStaticFile } from './static.js'
import {
  getMCPManagerForServers,
  initMcpLifecycle,
  invalidateMCPManagersForCwd,
} from './mcp-lifecycle.js'
import { initCodePlugins } from '../core/plugins/index.js'
import { handleChat } from './routes/chat.js'
import {
  getSafeSettings,
  parseWritableScope,
  patchSettings,
  resolveEffectiveSettings,
  setMCPServer,
} from '../core/settings-manager.js'
import { resolveRequestCwd, resolveSettingsRequestCwd } from './request-cwd.js'
import {
  createSession,
  getSession,
  listSessions,
  deleteSession,
  appendModeChange,
  canAccessSession,
} from './session.js'
import { sessionToUIMessages } from './session-ui.js'
import type { RouterOptions, MCPServerConfig, LlmProfile } from '../core/types.js'

registerBuiltinSubagents(defaultRegistry)
initCodePlugins(defaultRegistry).catch(err => {
  console.error(`[plugins] code plugin init failed: ${err.message}`)
})
initMcpLifecycle()

async function getMCPStatusForCwd(
  cwd: string,
  mcpServers: Record<string, import('../core/types.js').MCPServerConfig>,
) {
  const manager = await getMCPManagerForServers(cwd, mcpServers)
  return manager.getStatus()
}

export function createRouter({
  runAgent,
  staticDir,
}: RouterOptions) {
  const workspaceRouter = createWorkspaceRouter({ root: getDefaultWorkspace() })
  const skillsApi = createSkillsApi({ runAgent })

  return async (req: IncomingMessage, res: ServerResponse) => {
    setCORS(res, req)

    const { method, url } = req
    if (method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (method === 'GET' && url === '/health') {
      sendJSON(res, 200, { status: 'ok' })
      return
    }

    // ── Auth gate (only when AUTH_ENABLED=true) ──────────────────────────
    // Verifies the bearer token and pins `req.userWorkspace`. Everything
    // below this line is protected; `/health` and OPTIONS above are not.
    const authed = req as AuthedRequest
    if (isAuthEnabled()) {
      try {
        authenticateRequest(authed)
      } catch (e) {
        const err = e as AuthError
        sendJSON(res, err.statusCode ?? 401, { error: err.message })
        return
      }
    }

    if (method === 'GET' && url?.startsWith('/slash-commands')) {
      const query = new URLSearchParams(url.split('?')[1] ?? '')
      const workspace = query.get('workspace')
      const cwd =
        authed.userWorkspace ??
        (workspace && fs.existsSync(workspace)
          ? path.resolve(workspace)
          : getDefaultWorkspace())
      try {
        const entries = await listSlashCommands(cwd)
        sendJSON(res, 200, { workspace: cwd, entries })
      } catch (e) {
        sendJSON(res, 500, { error: (e as Error).message })
      }
      return
    }

    if (method === 'GET' && url?.startsWith('/plugins')) {
      const query = new URLSearchParams(url.split('?')[1] ?? '')
      const workspace = query.get('workspace')
      const cwd =
        authed.userWorkspace ??
        (workspace && fs.existsSync(workspace)
          ? path.resolve(workspace)
          : getDefaultWorkspace())
      try {
        const overview = await loadPluginsOverview(cwd)
        sendJSON(res, 200, { workspace: cwd, ...overview })
      } catch (e) {
        sendJSON(res, 500, { error: (e as Error).message })
      }
      return
    }

    if (await workspaceRouter(req, res)) return
    if (await skillsApi(req, res)) return

    if (method === 'POST' && url === '/sessions') {
      const session = createSession(authed.user?.email)
      console.log(`[server] new session: ${session.id}`)
      sendJSON(res, 200, { session_id: session.id })
      return
    }
    if (method === 'GET' && url === '/sessions') {
      // SSO: regular users see only their sessions; super see all.
      const owner =
        isAuthEnabled() && !isSuperUser(authed.user)
          ? authed.user?.email
          : undefined
      sendJSON(res, 200, {
        sessions: listSessions(owner),
        view_all: isSuperUser(authed.user),
      })
      return
    }
    if (method === 'DELETE' && url?.startsWith('/sessions/')) {
      const id = url.split('/sessions/')[1]
      const session = getSession(id)
      // 404 (not 403) when the caller doesn't own it — don't leak existence.
      // Super may view any session but may only delete their own.
      if (
        session &&
        !canAccessSession(session, authed.user?.email, authed.user?.role)
      ) {
        sendJSON(res, 404, { error: 'Session not found' })
        return
      }
      if (
        session &&
        isAuthEnabled() &&
        isSuperUser(authed.user) &&
        session.ownerEmail &&
        session.ownerEmail !== authed.user?.email
      ) {
        sendJSON(res, 403, { error: "Cannot delete another user's session" })
        return
      }
      deleteSession(id)
      sendJSON(res, 200, { deleted: id })
      return
    }
    if (method === 'GET' && url?.match(/^\/sessions\/[^/]+\/messages$/)) {
      const id = url.split('/sessions/')[1].split('/messages')[0]
      const session = getSession(id)
      if (
        !session ||
        !canAccessSession(session, authed.user?.email, authed.user?.role)
      ) {
        sendJSON(res, 404, { error: 'Session not found' })
        return
      }
      sendJSON(res, 200, { messages: sessionToUIMessages(session.messages) })
      return
    }

    if (method === 'GET' && url?.startsWith('/settings')) {
      const cwd = resolveSettingsRequestCwd(authed, url)
      const effective = await resolveEffectiveSettings(cwd)
      sendJSON(res, 200, {
        ...getSafeSettings(effective),
        cwd,
        sources: effective.sources,
        userDir: effective.userDir,
        projectDir: effective.projectDir,
        settingsPath: effective.projectPath,
        mcpServers: effective.config.mcpServers,
        effectiveMcpServers: effective.effectiveMcpServers,
        mcpStatus: await getMCPStatusForCwd(cwd, effective.effectiveMcpServers),
      })
      return
    }
    if (method === 'PATCH' && url === '/settings/provider') {
      try {
        const body = await readBody(req)
        const cwd = resolveSettingsRequestCwd(authed, url)
        const scope = parseWritableScope(body.scope, {
          ssoMode: isAuthEnabled() && !!authed.userWorkspace,
        })
        const providerPatch = { ...(body as Record<string, unknown>) }
        delete providerPatch.scope
        const resolved = patchSettings(cwd, scope, {
          provider: providerPatch as Partial<LlmProfile> as LlmProfile,
        })
        sendJSON(res, 200, {
          provider: getSafeSettings(resolved).provider,
          scope,
          sources: resolved.sources,
        })
      } catch (e) {
        sendJSON(res, 400, { error: (e as Error).message })
      }
      return
    }
    if (method === 'PATCH' && url === '/settings/mcp') {
      try {
        const body = await readBody(req)
        const action = body.action as string
        const cwd = resolveSettingsRequestCwd(authed, url)
        const scope = parseWritableScope(body.scope, {
          ssoMode: isAuthEnabled() && !!authed.userWorkspace,
        })
        let resolved = await resolveEffectiveSettings(cwd)

        if (action === 'add') {
          const name = body.name as string
          const config = body.config as MCPServerConfig
          if (!name || !config) {
            sendJSON(res, 400, { error: "Missing 'name' and/or 'config'" })
            return
          }
          setMCPServer(cwd, scope, name, config)
        } else if (action === 'remove') {
          const name = body.name as string
          if (!name) {
            sendJSON(res, 400, { error: "Missing 'name'" })
            return
          }
          setMCPServer(cwd, scope, name, null)
        } else {
          sendJSON(res, 400, { error: "action must be 'add' or 'remove'" })
          return
        }

        invalidateMCPManagersForCwd(cwd)
        resolved = await resolveEffectiveSettings(cwd)
        sendJSON(res, 200, {
          mcpServers: resolved.config.mcpServers,
          effectiveMcpServers: resolved.effectiveMcpServers,
          mcpStatus: await getMCPStatusForCwd(
            cwd,
            resolved.effectiveMcpServers,
          ),
          scope,
          sources: resolved.sources,
        })
      } catch (e) {
        sendJSON(res, 400, { error: (e as Error).message })
      }
      return
    }

    if (method === 'GET' && url?.startsWith('/mcp')) {
      const cwd = resolveSettingsRequestCwd(authed, url)
      const effective = await resolveEffectiveSettings(cwd)
      sendJSON(res, 200, {
        servers: await getMCPStatusForCwd(cwd, effective.effectiveMcpServers),
      })
      return
    }

    if (method === 'POST' && url === '/plan/approve') {
      try {
        const body = await readBody(req)
        const requestId = body.request_id as string
        const approved = body.approved as boolean
        const editedPlan = body.edited_plan as string | undefined
        const targetMode = body.target_mode as string | undefined
        const reason = body.reason as string | undefined

        if (!requestId || typeof approved !== 'boolean') {
          sendJSON(res, 400, { error: "Missing 'request_id' or 'approved'" })
          return
        }

        const ok = answerPlanApproval(requestId, {
          approved,
          editedPlan,
          targetMode:
            targetMode === 'ask' || targetMode === 'agent'
              ? targetMode
              : 'agent',
          reason,
        })
        sendJSON(
          res,
          ok ? 200 : 404,
          ok
            ? { ok: true }
            : { error: 'No pending plan approval with that id' },
        )
      } catch {
        sendJSON(res, 400, { error: 'Invalid JSON' })
      }
      return
    }

    if (method === 'POST' && url === '/session/mode') {
      try {
        const body = await readBody(req)
        const sessionId = body.session_id as string
        const mode = body.mode as string
        const workspace = body.workspace as string | undefined

        if (!sessionId || !isValidExternalMode(mode)) {
          sendJSON(res, 400, { error: "Missing 'session_id' or valid 'mode'" })
          return
        }

        const session = getSession(sessionId)
        if (
          !session ||
          !canAccessSession(session, authed.user?.email, authed.user?.role)
        ) {
          sendJSON(res, 404, { error: 'Session not found' })
          return
        }

        const from = session.permissionMode.mode
        if (from !== mode) {
          handlePlanModeTransition(from, mode, session)
          session.permissionMode = transitionPermissionMode(
            from,
            mode,
            session.permissionMode,
          )
          appendModeChange(sessionId, session)
        }

        const cwd =
          authed.userWorkspace ??
          (workspace && fs.existsSync(workspace)
            ? path.resolve(workspace)
            : getDefaultWorkspace())

        sendJSON(res, 200, {
          mode: session.permissionMode.mode,
          planFilePath: getPlanFilePath(session, cwd),
        })
      } catch {
        sendJSON(res, 400, { error: 'Invalid JSON' })
      }
      return
    }

    if (method === 'POST' && url === '/ask_user_question/answer') {
      try {
        const body = await readBody(req)
        const id = body.id as string
        const answers = body.answers as Record<string, string> | undefined
        const annotations = body.annotations as
          | Record<string, { preview?: string; notes?: string }>
          | undefined
        if (!id || !answers || typeof answers !== 'object') {
          sendJSON(res, 400, { error: "Missing 'id' or 'answers' object" })
          return
        }
        const ok = answerQuestion(id, { answers, annotations })
        sendJSON(
          res,
          ok ? 200 : 404,
          ok ? { ok: true } : { error: 'No pending question with that id' },
        )
      } catch {
        sendJSON(res, 400, { error: 'Invalid JSON' })
      }
      return
    }

    if (method === 'POST' && url?.split('?')[0] === '/chat') {
      await handleChat(req, res, runAgent)
      return
    }

    if (staticDir && serveStaticFile(req, res, staticDir)) return

    sendJSON(res, 404, { error: 'Not found' })
  }
}
