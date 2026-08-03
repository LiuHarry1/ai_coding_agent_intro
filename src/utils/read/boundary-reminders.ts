import { wrapInSystemReminder } from '../system-reminder.js'

/** Model-facing stub when Read would re-fetch unchanged content (dedup hit). */
export const FILE_UNCHANGED_STUB =
  'File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading.'

/** Model-facing stub when the file exists but has no bytes/lines. */
export const EMPTY_FILE_READ_REMINDER =
  'Warning: the file exists but the contents are empty.'

/** Model-facing stub when offset is past EOF (CC-compatible wording). */
export function offsetBeyondEofReminder(
  startLine: number,
  totalLines: number,
): string {
  return `Warning: the file exists but is shorter than the provided offset (${startLine}). The file has ${totalLines} lines.`
}

/**
 * Map an empty-content text Read into a short system-reminder for the model.
 * UI keeps structured Out (numLines=0); only the LLM path gets this string.
 */
export function formatTextReadBoundaryReminder(file: {
  startLine: number
  totalLines: number
}): string {
  if (file.totalLines === 0) {
    return wrapInSystemReminder(EMPTY_FILE_READ_REMINDER)
  }
  return wrapInSystemReminder(
    offsetBeyondEofReminder(file.startLine, file.totalLines),
  )
}
