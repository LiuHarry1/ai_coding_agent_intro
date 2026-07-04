import type { IncomingMessage, ServerResponse } from 'http'
import { resolvePath } from './path-safety.js'
import {
  listDir,
  readFile,
  createFile,
  saveFile,
  makeDir,
  removeEntry,
  FsOpError,
} from './fs-ops.js'

/**
 * Self-contained workspace HTTP module.
 *
 * - Handles all `/workspace/*` endpoints.
 * - Knows nothing about agent / sessions / MCP / config — only depends on
 *   `node:fs` and `node:path`.
 * - The host router composes it via `await workspaceRouter(req, res)`,
 *   which returns `true` iff the request was handled.
 */
export interface WorkspaceRouterOptions {
  /**
   * The workspace root advertised by `GET /workspace` and used as the cwd
   * for resolving relative paths. NOT a security sandbox — this module
   * intentionally allows browsing/creating anywhere on disk so the UI's
   * directory picker can pick or create a new workspace folder.
   */
  root: string
}

const MAX_BODY = 6 * 1024 * 1024

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        req.destroy()
        reject(new Error('Body too large'))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}'))
      } catch {
        reject(new Error('Invalid JSON'))
      }
    })
    req.on('error', reject)
  })
}

function sendJSON(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

function statusFor(err: unknown): number {
  if (!(err instanceof FsOpError)) return 500
  switch (err.code) {
    case 'ENOENT':
      return 404
    case 'EEXIST':
      return 409
    case 'EMTIME':
      return 409
    case 'ENOTEMPTY':
      return 409
    case 'E2BIG':
      return 413
    default:
      return 500
  }
}

function errorBody(err: unknown): { error: string; code?: string } {
  if (err instanceof FsOpError) return { error: err.message, code: err.code }
  return { error: err instanceof Error ? err.message : String(err) }
}

export function createWorkspaceRouter(opts: WorkspaceRouterOptions) {
  const { root } = opts

  return async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> => {
    const { method, url } = req
    if (!url || !url.startsWith('/workspace')) return false

    try {
      // GET /workspace
      if (method === 'GET' && url === '/workspace') {
        sendJSON(res, 200, { workspace: root })
        return true
      }

      // GET /workspace/list?dir=
      if (method === 'GET' && url.startsWith('/workspace/list')) {
        const params = new URL(url, `http://${req.headers.host}`).searchParams
        const dirParam = params.get('dir') || root
        sendJSON(res, 200, listDir(resolvePath(dirParam, root)))
        return true
      }

      // GET /workspace/file?path=
      if (method === 'GET' && url.startsWith('/workspace/file?')) {
        const params = new URL(url, `http://${req.headers.host}`).searchParams
        const p = params.get('path')
        if (!p) {
          sendJSON(res, 400, { error: "Missing 'path'" })
          return true
        }
        sendJSON(res, 200, readFile(resolvePath(p, root)))
        return true
      }

      // POST /workspace/file  { path, content }
      if (method === 'POST' && url === '/workspace/file') {
        const body = await readBody(req)
        const p = body.path as string | undefined
        const content = (body.content as string | undefined) ?? ''
        if (!p) {
          sendJSON(res, 400, { error: "Missing 'path'" })
          return true
        }
        sendJSON(res, 200, createFile(resolvePath(p, root), content))
        return true
      }

      // PUT /workspace/file  { path, content, mtimeMs? }
      if (method === 'PUT' && url === '/workspace/file') {
        const body = await readBody(req)
        const p = body.path as string | undefined
        const content = body.content as string | undefined
        const expectedMtimeMs = body.mtimeMs as number | undefined
        if (!p || content === undefined) {
          sendJSON(res, 400, { error: "Missing 'path' or 'content'" })
          return true
        }
        sendJSON(
          res,
          200,
          saveFile(resolvePath(p, root), content, expectedMtimeMs),
        )
        return true
      }

      // POST /workspace/mkdir  { path }
      if (method === 'POST' && url === '/workspace/mkdir') {
        const body = await readBody(req)
        const p = body.path as string | undefined
        if (!p) {
          sendJSON(res, 400, { error: "Missing 'path'" })
          return true
        }
        sendJSON(res, 200, makeDir(resolvePath(p, root)))
        return true
      }

      // DELETE /workspace/entry?path=
      if (method === 'DELETE' && url.startsWith('/workspace/entry')) {
        const params = new URL(url, `http://${req.headers.host}`).searchParams
        const p = params.get('path')
        if (!p) {
          sendJSON(res, 400, { error: "Missing 'path'" })
          return true
        }
        sendJSON(res, 200, removeEntry(resolvePath(p, root)))
        return true
      }

      return false
    } catch (err) {
      if (!res.headersSent) sendJSON(res, statusFor(err), errorBody(err))
      else res.end()
      return true
    }
  }
}

export { resolvePath } from './path-safety.js'
