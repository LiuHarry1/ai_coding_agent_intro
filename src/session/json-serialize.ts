/**
 * JSON helpers for session JSONL — Node's JSON.stringify turns Buffer into
 * `{ type: "Buffer", data: [...] }`, which does not round-trip into a Buffer
 * on JSON.parse and breaks AI SDK ModelMessage validation for image parts.
 *
 * Prefer chat-upload URL strings on ImagePart.image (claim-check). Buffer
 * tagging remains for legacy lines and tool-relocated images.
 */

import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import type { Message } from '../core/types.js'
import { isRoleMessage } from '../core/types.js'
import { hydrateImageBytes } from '../utils/chat-uploads.js'

const BUFFER_TAG = '__ai_agent_buffer__'

/** Replacer for JSON.stringify when persisting session lines. */
export function sessionJsonReplacer(_key: string, value: unknown): unknown {
  if (Buffer.isBuffer(value)) {
    return { [BUFFER_TAG]: true, base64: value.toString('base64') }
  }
  // Node calls Buffer.prototype.toJSON before the replacer for nested values,
  // so we often see `{ type: 'Buffer', data: number[] }` here — convert that
  // to tagged base64 (and avoid megabyte number-arrays in JSONL).
  if (isLegacyBufferJson(value)) {
    return {
      [BUFFER_TAG]: true,
      base64: Buffer.from(value.data).toString('base64'),
    }
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

/**
 * Walk message content and revive image/file fields for the model API:
 * tagged/legacy Buffer JSON, data URLs, `file://`, and `/sessions/.../uploads/...` refs.
 */
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
          const image = (part as { image: unknown }).image
          const mediaType = (part as { mediaType?: string }).mediaType
          const fromTag = reviveBufferValue(image)
          if (Buffer.isBuffer(fromTag)) {
            return fromTag !== image
              ? { ...part, image: fromTag }
              : part
          }
          if (typeof image === 'string') {
            try {
              const hydrated = hydrateImageBytes(image, mediaType)
              return {
                ...part,
                image: hydrated.buffer,
                mediaType: mediaType ?? hydrated.mediaType,
              }
            } catch {
              return part
            }
          }
        }
        if (
          typeof part === 'object' &&
          part !== null &&
          (part as { type?: string }).type === 'file' &&
          'data' in part
        ) {
          const data = (part as { data: unknown }).data
          const mediaType = (part as { mediaType?: string }).mediaType
          const fromTag = reviveBufferValue(data)
          if (Buffer.isBuffer(fromTag)) {
            return fromTag !== data ? { ...part, data: fromTag } : part
          }
          if (typeof data === 'string') {
            try {
              const hydrated = hydrateFileBytes(data, mediaType)
              return {
                ...part,
                data: hydrated.buffer,
                mediaType: mediaType ?? hydrated.mediaType,
              }
            } catch {
              return part
            }
          }
        }
        return part
      }),
    }
  }) as Message[]
}

function hydrateFileBytes(
  ref: string,
  mediaType?: string,
): { buffer: Buffer; mediaType: string } {
  if (ref.startsWith('file://')) {
    const abs = fileURLToPath(ref)
    const buffer = readFileSync(abs)
    return {
      buffer,
      mediaType: mediaType ?? 'application/pdf',
    }
  }
  if (ref.startsWith('data:')) {
    const match = ref.match(/^data:([^;]+);base64,(.+)$/s)
    if (!match) throw new Error('Invalid data URL')
    return {
      buffer: Buffer.from(match[2]!, 'base64'),
      mediaType: mediaType ?? match[1]!,
    }
  }
  // Reuse image hydrate for upload URLs when applicable.
  const hydrated = hydrateImageBytes(ref, mediaType)
  return { buffer: hydrated.buffer, mediaType: mediaType ?? hydrated.mediaType }
}

export function parseSessionJsonLine(line: string): Record<string, unknown> {
  return JSON.parse(line, sessionJsonReviver) as Record<string, unknown>
}

export function stringifySessionJsonLine(data: Record<string, unknown>): string {
  return JSON.stringify(data, sessionJsonReplacer)
}
