/**
 * Chat SSE transport.
 *
 * HTTP via agentApi (SSO auth + response headers); SSE via local parseSSE.
 * Does not depend on `@ai-agent/client` (that package is for headless callers).
 */
import { parseSSE } from '../../lib/sse.js'
import { agentApi } from '../../lib/api/agent.js'

/**
 * @typedef {{
 *   sessionId: string | null,
 *   permissionMode: string | null,
 *   agentType: string | undefined,
 * }} ChatStreamMeta
 */

/**
 * Open POST /chat, parse SSE, invoke onEvent for each protocol message.
 *
 * @param {{
 *   body: Record<string, unknown>,
 *   signal: AbortSignal,
 *   onEvent: (data: object) => void,
 *   onHttpError: (info: { status: number, message: string }) => void,
 *   onSessionNotFound?: () => void,
 * }} opts
 * @returns {Promise<ChatStreamMeta | null>} meta after successful stream open; null if aborted by HTTP error handler
 */
export async function streamChatTurn({
  body,
  signal,
  onEvent,
  onHttpError,
  onSessionNotFound,
}) {
  const postChat = sessionId =>
    agentApi.postChat({ ...body, session_id: sessionId }, signal)

  let res = await postChat(body.session_id ?? null)

  if (!res.ok && res.status === 404) {
    const errText = await res.text()
    if (errText.includes('Session not found')) {
      onSessionNotFound?.()
      res = await postChat(null)
    } else {
      onHttpError({ status: res.status, message: errText })
      return null
    }
  }

  if (!res.ok) {
    const errText = await res.text()
    let friendly = errText
    try {
      const parsed = JSON.parse(errText)
      if (parsed?.error) friendly = parsed.error
    } catch {
      /* not JSON */
    }
    onHttpError({
      status: res.status,
      message:
        res.status === 409 ? friendly : `HTTP ${res.status}: ${friendly}`,
    })
    return null
  }

  const meta = {
    sessionId: res.headers.get('x-session-id'),
    permissionMode: res.headers.get('x-permission-mode'),
    // Distinguish "header absent" from "header empty" (clear agent type).
    agentType: res.headers.has('x-agent-type')
      ? res.headers.get('x-agent-type')
      : undefined,
  }

  if (!res.body) {
    onHttpError({ status: res.status, message: 'Empty response body' })
    return null
  }

  for await (const data of parseSSE(res.body, signal)) {
    if (!data || typeof data !== 'object' || !data.type) continue
    if (data.type === 'unknown') continue
    try {
      onEvent(data)
    } catch (e) {
      console.error('[SSE] handler error:', data.type, e)
    }
  }

  return meta
}

/**
 * Open GET /sessions/:id/live and yield protocol messages until aborted.
 *
 * @param {{
 *   sessionId: string,
 *   signal: AbortSignal,
 *   onEvent: (data: object) => void,
 * }} opts
 */
export async function streamSessionLive({ sessionId, signal, onEvent }) {
  const res = await agentApi.streamSessionLive(sessionId, signal)
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`)
    err.status = res.status
    throw err
  }
  if (!res.body) {
    const err = new Error('Empty response body')
    err.status = res.status
    throw err
  }
  for await (const data of parseSSE(res.body, signal)) {
    if (!data || typeof data !== 'object' || !data.type) continue
    if (data.type === 'unknown' || data.type === 'keep_alive') continue
    try {
      onEvent(data)
    } catch (e) {
      console.error('[SSE live] handler error:', data.type, e)
    }
  }
}
