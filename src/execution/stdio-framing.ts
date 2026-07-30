/**
 * NDJSON framing for RuntimePort over stdio (one JSON object per line).
 */
import type { Readable, Writable } from 'stream'
import type {
  RuntimeClientMessage,
  RuntimeServerMessage,
} from './runtime-protocol.js'

export type AnyRuntimeMessage = RuntimeClientMessage | RuntimeServerMessage

export function writeNdjson(stream: Writable, msg: AnyRuntimeMessage): void {
  stream.write(`${JSON.stringify(msg)}\n`)
}

/**
 * Attach a line-oriented JSON parser to a readable stream.
 * Returns an unsubscribe function.
 */
export function onNdjsonLines(
  stream: Readable,
  onMessage: (msg: AnyRuntimeMessage) => void,
  onError?: (err: Error) => void,
): () => void {
  let buf = ''
  const onData = (chunk: Buffer | string) => {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    let idx: number
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '')
      buf = buf.slice(idx + 1)
      if (!line.trim()) continue
      try {
        onMessage(JSON.parse(line) as AnyRuntimeMessage)
      } catch (err) {
        onError?.(
          err instanceof Error
            ? err
            : new Error(`Invalid NDJSON from worker: ${line.slice(0, 200)}`),
        )
      }
    }
  }
  stream.on('data', onData)
  return () => {
    stream.off('data', onData)
  }
}
