/**
 * Streaming-arg preview for select tools.
 *
 * For tools whose main payload is a long string field (e.g. write_file's
 * `content`, edit_file's `new_string`), the parent agent loop wants to
 * surface that *decoded* string to the UI as the model types it — not
 * wait for the full JSON args blob to parse. Otherwise users sit on a
 * "Generating arguments…" spinner for 10+ seconds while a 2k-token file
 * streams in.
 *
 * This module is responsible for one thing only: given a partial,
 * potentially-mid-escape-sequence JSON buffer being concatenated from
 * `tool-input-delta` chunks, extract the running plain-text value of a
 * known field and report newly-emitted characters.
 *
 * Add a tool to `PREVIEW_FIELDS` when its UX benefits from a live
 * preview. Tools not listed here just fall back to the byte counter.
 */

export const PREVIEW_FIELDS: Record<string, string> = {
  edit_file: 'new_string',
  write_file: 'content',
}

export interface PreviewState {
  toolName: string
  fieldName: string
  buffer: string
  /** -1 = field's opening quote not yet seen in the buffer. */
  fieldStartIdx: number
  /** How many decoded chars we've already emitted via `tool_input_preview_delta`. */
  emittedLen: number
  ended: boolean
}

/** Locate the opening quote of `"<fieldName>":"…"` in a partial JSON buffer. */
export function findFieldValueStart(buffer: string, fieldName: string): number {
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`"${escaped}"\\s*:\\s*"`)
  const m = re.exec(buffer)
  return m ? m.index + m[0].length : -1
}

const ESCAPE_MAP: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  n: '\n',
  t: '\t',
  r: '\r',
  b: '\b',
  f: '\f',
}

/**
 * Decode a JSON string starting at `startIdx` in `buffer`, stopping at the
 * unescaped closing `"` or end of buffer (whichever comes first). Tolerant
 * of being called repeatedly as the buffer grows — characters left undecoded
 * because of an incomplete escape sequence are simply not emitted yet; the
 * next call sees the completed escape and decodes it.
 */
export function decodeStreamingJsonString(
  buffer: string,
  startIdx: number,
): { value: string; ended: boolean } {
  let out = ''
  let i = startIdx
  while (i < buffer.length) {
    const ch = buffer[i]
    if (ch === '"') return { value: out, ended: true }
    if (ch === '\\') {
      if (i + 1 >= buffer.length) break // wait for the escape char
      const esc = buffer[i + 1]
      if (esc === 'u') {
        if (i + 6 > buffer.length) break // wait for all 4 hex digits
        const hex = buffer.slice(i + 2, i + 6)
        const code = parseInt(hex, 16)
        if (!Number.isNaN(code)) out += String.fromCharCode(code)
        i += 6
        continue
      }
      out += ESCAPE_MAP[esc] ?? esc
      i += 2
      continue
    }
    out += ch
    i++
  }
  return { value: out, ended: false }
}

/**
 * Apply a new `tool-input-delta` chunk to an existing preview state and
 * return the newly-decoded substring (or empty string if nothing visible
 * yet, e.g. the field's opening quote hasn't arrived). Centralizes the
 * three-step pattern: append → locate → decode-and-diff.
 */
export function appendPreviewDelta(
  state: PreviewState,
  deltaText: string,
): string {
  if (state.ended) return ''
  state.buffer += deltaText
  if (state.fieldStartIdx === -1) {
    state.fieldStartIdx = findFieldValueStart(state.buffer, state.fieldName)
    if (state.fieldStartIdx === -1) return ''
  }
  const { value, ended } = decodeStreamingJsonString(
    state.buffer,
    state.fieldStartIdx,
  )
  if (ended) state.ended = true
  if (value.length <= state.emittedLen) return ''
  const out = value.slice(state.emittedLen)
  state.emittedLen = value.length
  return out
}

/**
 * Stand up a preview state for a tool, or return null if the tool isn't
 * listed in `PREVIEW_FIELDS` (no preview desired, fall back to byte
 * counter).
 */
export function maybeStartPreview(
  toolName: string | undefined,
): PreviewState | null {
  if (!toolName) return null
  const fieldName = PREVIEW_FIELDS[toolName]
  if (!fieldName) return null
  return {
    toolName,
    fieldName,
    buffer: '',
    fieldStartIdx: -1,
    emittedLen: 0,
    ended: false,
  }
}
