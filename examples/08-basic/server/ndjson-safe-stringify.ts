/**
 * JSON.stringify for one-message-per-line transports.
 * 
 */
const JS_LINE_TERMINATORS = /\u2028|\u2029/g

export function ndjsonSafeStringify(value: unknown): string {
  return JSON.stringify(value).replace(JS_LINE_TERMINATORS, c =>
    c === '\u2028' ? '\\u2028' : '\\u2029',
  )
}
