import type { ServerResponse } from 'http'
import type { SSETransport } from '../core/types.js'
import type { OutgoingMessage } from '../../../protocol/src/wire.js'
import type { ProtocolSink } from '../core/protocol-sink.js'

/** SSE event name for a protocol message: `system.init`, `tool_call`, … */
export function protocolEventName(msg: OutgoingMessage): string {
  if (msg.type === 'control_request' || msg.type === 'control_response') {
    return msg.type
  }
  return 'subtype' in msg && typeof msg.subtype === 'string'
    ? `${msg.type}.${msg.subtype}`
    : msg.type
}

/**
 * SSE transport — dumb serializer for `@ai-agent/protocol` messages.
 * 
 */
export function createSSETransport(
  res: ServerResponse,
  extraHeaders: Record<string, string> = {},
): SSETransport {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Agent-Protocol': '1',
    ...extraHeaders,
  })

  const sink: ProtocolSink = {
    emit(msg: OutgoingMessage): void {
      if (res.writableEnded) return
      res.write(
        `event: ${protocolEventName(msg)}\ndata: ${JSON.stringify(msg)}\n\n`,
      )
    },
  }

  res.on('close', () => {
    // Response ended; further emits are no-ops via writableEnded check.
  })

  return {
    emit(msg: OutgoingMessage) {
      sink.emit(msg)
    },
    end() {
      if (!res.writableEnded) res.end()
    },
  }
}
