import type { ServerResponse } from 'http'
import type { IEventBus, SSETransport } from '../core/types.js'
import {
  mapLegacyEvent,
  type ServerMessage,
} from '../../../protocol/src/index.js'

/**
 * Options that switch the transport into protocol mode.
 *
 * Legacy mode (default) is byte-for-byte unchanged: it forwards raw
 * eventBus `(event, data)` pairs as `event: <name>\ndata: <json>`, which
 * is what today's web UI and `@ai-agent/client` already consume.
 *
 * Protocol mode (opt-in, `?protocol=1`) runs every event through
 * `mapLegacyEvent` so the wire carries `@ai-agent/protocol` `ServerMessage`s
 * instead. New GUIs and the future NDJSON / ACP adapters consume this.
 */
export interface SSETransportOptions {
  protocol?: boolean
  /** Session id used to stamp protocol messages that omit it. */
  sessionId?: string
  /** Current permission mode, used to fill the protocol init handshake. */
  mode?: string
}

/** SSE event name for a protocol message: `system.init`, `tool_call`, … */
function protocolEventName(msg: ServerMessage): string {
  return 'subtype' in msg && typeof msg.subtype === 'string'
    ? `${msg.type}.${msg.subtype}`
    : msg.type
}

export function createSSETransport(
  res: ServerResponse,
  eventBus: IEventBus,
  extraHeaders: Record<string, string> = {},
  opts: SSETransportOptions = {},
): SSETransport {
  const useProtocol = Boolean(opts.protocol)
  const ctx = { session_id: opts.sessionId ?? '', mode: opts.mode }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    ...(useProtocol ? { 'X-Agent-Protocol': '1' } : {}),
    ...extraHeaders,
  })

  // Single funnel for both the wildcard subscription and explicit send():
  // in protocol mode we translate (and drop internal-only events that map
  // to null); in legacy mode we pass the pair through verbatim.
  const write = (event: string, data: unknown): void => {
    if (res.writableEnded) return
    if (useProtocol) {
      const msg = mapLegacyEvent(event, data, ctx)
      if (!msg) return
      res.write(
        `event: ${protocolEventName(msg)}\ndata: ${JSON.stringify(msg)}\n\n`,
      )
    } else {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }
  }

  const unsubscribe = eventBus.on('*', (data: unknown, event: string) => {
    write(event, data)
  })

  res.on('close', () => {
    unsubscribe()
  })

  return {
    send(event: string, data: unknown) {
      write(event, data)
    },
    end() {
      unsubscribe()
      if (!res.writableEnded) res.end()
    },
  }
}
