import type { OutgoingMessage } from '../../../protocol/src/wire.js'

/** 
export interface ProtocolSink {
  emit(msg: OutgoingMessage): void
}

export const noopProtocolSink: ProtocolSink = {
  emit() {},
}
