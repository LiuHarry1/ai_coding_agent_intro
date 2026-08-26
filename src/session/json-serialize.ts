/**
 * JSON helpers for session JSONL — Node's JSON.stringify turns Buffer into
 * `{ type: "Buffer", data: [...] }`, which does not round-trip into a Buffer
 * on JSON.parse and breaks AI SDK ModelMessage validation for image parts.
 */

import type { Message } from '../core/types.js'
import { isRoleMessage } from '../core/types.js'

const BUFFER_TAG = '__ai_agent_buffer__'

/** Replacer for JSON.stringify when persisting session lines. */
export function sessionJsonReplacer(_key: string, value: unknown): unknown {
  if (Buffer.isBuffer(value)) {
    return { [BUFFER_TAG]: true, base64: value.toString('base64') }
  }
  return value
}

function isLegacyBufferJson(
  value: unknown,
): value is { type: 'Buffer'; data: number[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: string }).type === 'Buffer' &&
    Array.isArray((value as { data?: unknown }).data)
  )
}

function isTaggedBufferJson(
  value: unknown,
): value is { [BUFFER_TAG]: true; base64: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)[BUFFER_TAG] === true &&
    typeof (value as { base64?: unknown }).base64 === 'string'
  )
}

/** Reviver for JSON.parse when restoring session lines. */
export function sessionJsonReviver(_key: string, value: unknown): unknown {
  if (isTaggedBufferJson(value)) {
    return Buffer.from(value.base64, 'base64')
  }
  if (isLegacyBufferJson(value)) {
    return Buffer.from(value.data)
  }
  return value
}

function reviveBufferValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return value
  if (isTaggedBufferJson(value)) {
    return Buffer.from(value.base64, 'base64')
  }
  if (isLegacyBufferJson(value)) {
    return Buffer.from(value.data)
  }
  return value
}

/** Walk message content and revive serialized Buffer image fields. */
export function reviveBuffersInMessages(messages: Message[]): Message[] {
  return messages.map(m => {
    if (!isRoleMessage(m) || !Array.isArray(m.content)) return m
    return {
      ...m,
      content: m.content.map(part => {
        if (
          typeof part === 'object' &&
          part !== null &&
          (part as { type?: string }).type === 'image' &&
          'image' in part
        ) {
          const revived = reviveBufferValue((part as { image: unknown }).image)
          if (revived !== (part as { image: unknown }).image) {
            return { ...part, image: revived }
          }
        }
        return part
      }),
    }
  }) as Message[]
}

export function parseSessionJsonLine(line: string): Record<string, unknown> {
  return JSON.parse(line, sessionJsonReviver) as Record<string, unknown>
}

export function stringifySessionJsonLine(data: Record<string, unknown>): string {
  return JSON.stringify(data, sessionJsonReplacer)
}
