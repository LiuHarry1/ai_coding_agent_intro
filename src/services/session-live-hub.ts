/**
 * Process-level fan-out for long-lived session SSE.
 * HTTP subscribe lives in `src/server/session-live.ts`; cron fire uses
 * `createSessionLiveTransport` so a hung client cannot fail the turn.
 */
import type { ServerResponse } from 'http'
import type { SSETransport } from '../core/types.js'
import type { OutgoingMessage } from '../../protocol/src/wire.js'

const subscribers = new Map<string, Set<ServerResponse>>()

function protocolEventName(msg: OutgoingMessage): string {
  if (msg.type === 'control_request' || msg.type === 'control_response') {
    return msg.type
  }
  return 'subtype' in msg && typeof msg.subtype === 'string'
    ? `${msg.type}.${msg.subtype}`
    : msg.type
}

function writeSse(res: ServerResponse, msg: OutgoingMessage): boolean {
  if (res.writableEnded) return false
  let payload: string
  try {
    payload = JSON.stringify(msg).replace(/\u2028|\u2029/g, c =>
      c === '\u2028' ? '\\u2028' : '\\u2029',
    )
  } catch (err) {
    console.warn(
      `[session-live] stringify failed: ${err instanceof Error ? err.message : err}`,
    )
    return false
  }
  try {
    res.write(`event: ${protocolEventName(msg)}\ndata: ${payload}\n\n`)
    return true
  } catch {
    try {
      res.destroy()
    } catch {
      /* already gone */
    }
    return false
  }
}

export function subscribeSessionLive(
  sessionId: string,
  res: ServerResponse,
): () => void {
  let set = subscribers.get(sessionId)
  if (!set) {
    set = new Set()
    subscribers.set(sessionId, set)
  }
  set.add(res)
  const unsubscribe = () => {
    set.delete(res)
    if (set.size === 0) subscribers.delete(sessionId)
  }
  res.on('close', unsubscribe)
  return unsubscribe
}

export function emitToSessionLive(
  sessionId: string,
  msg: OutgoingMessage,
): void {
  const set = subscribers.get(sessionId)
  if (!set) return
  for (const res of [...set]) {
    if (!writeSse(res, msg)) {
      set.delete(res)
    }
  }
  if (set.size === 0) subscribers.delete(sessionId)
}

/** Keep-alive for one subscriber; do not fan out (each connection has its own timer). */
export function writeSessionLiveKeepAlive(res: ServerResponse): void {
  writeSse(res, { type: 'keep_alive' })
}

export function createSessionLiveTransport(sessionId: string): SSETransport {
  return {
    emit(msg) {
      emitToSessionLive(sessionId, msg)
    },
    end() {
      // Keep the live SSE open for the next turn.
    },
  }
}
