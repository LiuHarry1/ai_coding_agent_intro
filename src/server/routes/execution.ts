import type { IncomingMessage, ServerResponse } from 'http'
import { readBody, sendJSON } from '../http.js'
import {
  getExecutionPlane,
  isWorkspaceHandle,
  prewarmRuntime,
  type WorkspaceHandle,
} from '../../execution/index.js'
import {
  getSession,
  canAccessSession,
  setSessionWorkspace,
} from '../session.js'
import type { AuthedRequest } from '../auth/identity.js'

/**
 * Execution Environment HTTP API.
 *
 * GET    /environments
 * POST   /environments/resolve     { input }
 * POST   /environments/connect     { environmentId | input, preferredCwd? }
 * POST   /environments/disconnect  { connectionId }
 * GET    /environments/fs/list?environmentId=&path=
 * GET    /environments/fs/stat?environmentId=&path=
 * GET    /environments/fs/file?environmentId=&path=
 * POST   /sessions/:id/workspace   { environmentId, cwd }
 * GET    /sessions/:id/workspace
 */
export function createExecutionRouter() {
  return async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> => {
    const method = req.method ?? 'GET'
    const url = req.url ?? ''
    const pathOnly = url.split('?')[0]

    if (!pathOnly.startsWith('/environments') && !isSessionWorkspacePath(pathOnly)) {
      return false
    }

    let plane
    try {
      plane = getExecutionPlane()
    } catch (err) {
      sendJSON(res, 503, {
        error: err instanceof Error ? err.message : String(err),
      })
      return true
    }

    try {
      if (method === 'GET' && pathOnly === '/environments') {
        const envs = await plane.registry.listAll()
        sendJSON(res, 200, {
          environments: envs.map(e => ({
            id: e.id,
            kind: e.kind,
            displayName: e.displayName,
            defaultCwd: e.defaultCwd,
            capabilities: e.capabilities,
          })),
        })
        return true
      }

      if (method === 'POST' && pathOnly === '/environments/resolve') {
        const body = await readBody(req)
        const input = String(body.input ?? '')
        const env = await plane.registry.resolve(input)
        sendJSON(res, 200, {
          id: env.id,
          kind: env.kind,
          displayName: env.displayName,
          defaultCwd: env.defaultCwd,
          capabilities: env.capabilities,
        })
        return true
      }

      if (method === 'POST' && pathOnly === '/environments/connect') {
        const body = await readBody(req)
        const input = String(body.environmentId ?? body.input ?? '')
        const preferredCwd =
          typeof body.preferredCwd === 'string' ? body.preferredCwd : undefined
        const conn = await plane.registry.connect(input, { preferredCwd })
        sendJSON(res, 200, {
          connectionId: conn.id,
          status: conn.status,
          environment: {
            id: conn.env.id,
            kind: conn.env.kind,
            displayName: conn.env.displayName,
            defaultCwd: conn.env.defaultCwd,
          },
        })
        return true
      }

      if (method === 'POST' && pathOnly === '/environments/disconnect') {
        const body = await readBody(req)
        const connectionId = String(body.connectionId ?? '')
        await plane.registry.disconnect(connectionId)
        sendJSON(res, 200, { ok: true })
        return true
      }

      if (method === 'GET' && pathOnly === '/environments/fs/list') {
        const q = new URL(url, 'http://localhost').searchParams
        const environmentId = q.get('environmentId')
        const dirPath = q.get('path')
        if (!environmentId) {
          sendJSON(res, 400, { error: 'Missing environmentId' })
          return true
        }
        await plane.registry.connect(environmentId)
        const envs = await plane.registry.listAll()
        const env = envs.find(e => e.id === environmentId)
        const cwd =
          dirPath ||
          env?.defaultCwd ||
          (environmentId === 'local' ? '.' : '~')
        const { dir, entries } = await plane.workspaces.listWithDir(
          { environmentId, cwd },
          cwd,
        )
        sendJSON(res, 200, { environmentId, dir, entries })
        return true
      }

      if (method === 'GET' && pathOnly === '/environments/fs/stat') {
        const q = new URL(url, 'http://localhost').searchParams
        const environmentId = q.get('environmentId')
        const filePath = q.get('path')
        if (!environmentId || !filePath) {
          sendJSON(res, 400, { error: 'Missing environmentId or path' })
          return true
        }
        await plane.registry.connect(environmentId)
        const st = await plane.workspaces.stat(
          { environmentId, cwd: filePath },
          filePath,
        )
        sendJSON(res, 200, st)
        return true
      }

      if (method === 'GET' && pathOnly === '/environments/fs/file') {
        const q = new URL(url, 'http://localhost').searchParams
        const environmentId = q.get('environmentId')
        const filePath = q.get('path')
        if (!environmentId || !filePath) {
          sendJSON(res, 400, { error: 'Missing environmentId or path' })
          return true
        }
        await plane.registry.connect(environmentId)
        const MAX = 2 * 1024 * 1024
        const data = await plane.workspaces.read(
          { environmentId, cwd: filePath },
          filePath,
          { encoding: 'utf-8' },
        )
        const content = typeof data === 'string' ? data : ''
        const truncated = content.length > MAX
        sendJSON(res, 200, {
          path: filePath,
          content: truncated ? content.slice(0, MAX) : content,
          size: content.length,
          truncated,
          isBinary: false,
          mtimeMs: Date.now(),
        })
        return true
      }

      // POST /sessions/:id/workspace
      const bindMatch = /^\/sessions\/([^/]+)\/workspace$/.exec(pathOnly)
      if (bindMatch && method === 'POST') {
        const sessionId = bindMatch[1]
        const session = getSession(sessionId)
        const authed = req as AuthedRequest
        if (
          !session ||
          !canAccessSession(session, authed.user?.email, authed.user?.role)
        ) {
          sendJSON(res, 404, { error: `Session not found: ${sessionId}` })
          return true
        }
        const body = await readBody(req)
        if (!isWorkspaceHandle(body)) {
          sendJSON(res, 400, {
            error: 'Body must include environmentId and cwd',
          })
          return true
        }
        const normalized = await plane.workspaces.normalizeHandle(body)
        setSessionWorkspace(sessionId, normalized)
        const label = await plane.workspaces.label(normalized)
        // Warm the runtime in the background: binding a workspace shouldn't
        // wait on a process launch, and the first turn reuses whatever this
        // opens (RuntimeBroker keys by environmentId::cwd).
        prewarmRuntime(normalized)
        sendJSON(res, 200, { workspace: normalized, label })
        return true
      }

      if (bindMatch && method === 'GET') {
        const sessionId = bindMatch[1]
        const session = getSession(sessionId)
        const authed = req as AuthedRequest
        if (
          !session ||
          !canAccessSession(session, authed.user?.email, authed.user?.role)
        ) {
          sendJSON(res, 404, { error: `Session not found: ${sessionId}` })
          return true
        }
        if (!session.workspace) {
          sendJSON(res, 200, { workspace: null, label: null })
          return true
        }
        const label = await plane.workspaces.label(session.workspace)
        sendJSON(res, 200, { workspace: session.workspace, label })
        return true
      }

      return false
    } catch (err) {
      sendJSON(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      })
      return true
    }
  }
}

function isSessionWorkspacePath(pathOnly: string): boolean {
  return /^\/sessions\/[^/]+\/workspace$/.test(pathOnly)
}
