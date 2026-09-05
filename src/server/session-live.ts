/**
 * GET /sessions/:id/live — long-lived SSE for scheduled (and other
 * non-POST /chat) turns. Fan-out lives in session-live-hub.
 */
import type { IncomingMessage, ServerResponse } from 'http'
import {
  canAccessSession,
  getSession,
} from './session.js'
import type { AuthedRequest } from './auth/identity.js'
import { sendJSON } from './http.js'
import {
  subscribeSessionLive,
  writeSessionLiveKeepAlive,
} from '../services/session-live-hub.js'

const KEEP_ALIVE_MS = 20_000

export function handleSessionLive(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  if (req.method !== 'GET') return false
  const pathname = (req.url ?? '').split('?')[0]
  const match = pathname.match(/^\/sessions\/([^/]+)\/live$/)
  if (!match) return false

  const id = decodeURIComponent(match[1]!)
  const authed = req as AuthedRequest
  const session = getSession(id)
  if (
    !session ||
    !canAccessSession(session, authed.user?.email, authed.user?.role)
  ) {
    sendJSON(res, 404, { error: 'Session not found' })
    return true
  }

  req.socket.setTimeout(0)
  req.setTimeout(0)
  res.setTimeout(0)
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Agent-Protocol': '1',
  })
  res.write(': connected\n\n')

  const unsubscribe = subscribeSessionLive(id, res)
  const keepAlive = setInterval(() => {
    writeSessionLiveKeepAlive(res)
  }, KEEP_ALIVE_MS)
  keepAlive.unref?.()

  const cleanup = () => {
    clearInterval(keepAlive)
    unsubscribe()
  }
  res.on('close', cleanup)
  req.on('close', cleanup)
  return true
}
