import type { OutgoingMessage } from '../../../protocol/src/wire.js'

/** CC ref: src/utils/stream.ts — single outbound queue for wire messages. */
export interface ProtocolSink {
  emit(msg: OutgoingMessage): void
}

export const noopProtocolSink: ProtocolSink = {
  emit() {},
}
