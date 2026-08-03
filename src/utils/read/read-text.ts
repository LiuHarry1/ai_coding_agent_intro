/**
 * Slice UTF-8 text / load from disk into dual-channel Read Out.
 * Formatting for the model lives in format-for-model.ts.
 */
import * as fs from 'fs'
import * as path from 'path'
import { isBinaryContent } from '../../constants/files.js'
import { MAX_LINES_TO_READ, MAX_OUTPUT_SIZE_BYTES } from './limits.js'
import { readTextFromString } from './read-from-string.js'
import type { ReadTextOutput } from './types.js'
import { FileTooLargeError } from './types.js'

export { roughTokenEstimate } from './read-from-string.js'
export { addLineNumbers, formatTextReadForModel } from './format-for-model.js'

export function readTextFile(
  absPath: string,
  displayPath: string,
  options?: { offset?: number; limit?: number },
): ReadTextOutput {
  if (!fs.existsSync(absPath)) {
    throw new Error(`file not found: ${displayPath}`)
  }
  const stat = fs.statSync(absPath)
  if (stat.isDirectory()) {
    throw new Error(`${displayPath} is a directory, not a file`)
  }

  // When the caller supplies offset/limit, read only that window — no
  // whole-file size/line gate. Without a range, files larger than
  // MAX_OUTPUT_SIZE_BYTES or MAX_LINES_TO_READ must use offset/limit.
  const hasRange =
    options?.limit != null || (options?.offset != null && options.offset > 1)
  if (stat.size > MAX_OUTPUT_SIZE_BYTES) {
    if (hasRange) {
      return readTextFileTruncated(absPath, displayPath, {
        offset: options?.offset ?? 1,
        limit: options?.limit,
      })
    }
    throw new FileTooLargeError(stat.size, MAX_OUTPUT_SIZE_BYTES)
  }

  const buf = fs.readFileSync(absPath)
  if (isBinaryContent(buf)) {
    throw new Error(`binary file detected — cannot display ${displayPath}`)
  }

  return readTextFromString(buf.toString('utf-8'), displayPath, options)
}

/** Max bytes we'll load whole-file for @-mention truncation (streaming TBD for larger). */
const TRUNCATED_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024

/** Read first N lines when file exceeds token/line budget (attachment truncation). */
export function readTextFileTruncated(
  absPath: string,
  displayPath: string,
  options?: { offset?: number; limit?: number },
): ReadTextOutput {
  const lineLimit = Math.min(
    options?.limit ?? MAX_LINES_TO_READ,
    MAX_LINES_TO_READ,
  )
  const offset = options?.offset ?? 1

  if (isFileWithinReadSizeLimit(absPath)) {
    return readTextFile(absPath, displayPath, { offset, limit: lineLimit })
  }

  // Oversized on disk: still attach a prefix of lines for @-file paths. Only
  // read whole file when below TRUNCATED_ATTACHMENT_MAX_BYTES — avoids the
  // MAX_OUTPUT_SIZE_BYTES gate in readTextFile() that blocks @-mentions.
  if (!fs.existsSync(absPath)) {
    throw new Error(`file not found: ${displayPath}`)
  }
  const stat = fs.statSync(absPath)
  if (stat.isDirectory()) {
    throw new Error(`${displayPath} is a directory, not a file`)
  }
  if (stat.size > TRUNCATED_ATTACHMENT_MAX_BYTES) {
    throw new FileTooLargeError(stat.size, TRUNCATED_ATTACHMENT_MAX_BYTES)
  }

  const buf = fs.readFileSync(absPath)
  if (isBinaryContent(buf)) {
    throw new Error(`binary file detected — cannot display ${displayPath}`)
  }

  return readTextFromString(buf.toString('utf-8'), displayPath, {
    offset,
    limit: lineLimit,
    enforceWholeFileLineGate: false,
  })
}

export function isFileWithinReadSizeLimit(
  absPath: string,
  maxBytes = MAX_OUTPUT_SIZE_BYTES,
): boolean {
  try {
    return fs.statSync(absPath).size <= maxBytes
  } catch {
    return false
  }
}

export function fileExtension(absPath: string): string {
  return path.extname(absPath).replace(/^\./, '').toLowerCase()
}
