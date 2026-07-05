import type { SSETransport } from '../core/types.js'
import type { OutgoingMessage } from '../../../protocol/src/wire.js'
import { ndjsonSafeStringify } from './ndjson-safe-stringify.js'

/**
 * Stdio NDJSON transport — 
 * One `@ai-agent/protocol` message per line on stdout.
 */
export function createStdioTransport(): SSETransport {
  return {
    emit(msg: OutgoingMessage): void {
      process.stdout.write(ndjsonSafeStringify(msg) + '\n')
    },
    end() {
      /* stdout stays open for multi-turn CLI sessions */
    },
  }
}
