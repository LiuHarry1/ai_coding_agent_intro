import * as fs from 'fs'
import * as path from 'path'
import {
  MAX_LINES_TO_READ,
  MAX_OUTPUT_SIZE_BYTES,
} from '../../constants/api_limits.js'
import { isBinaryContent } from '../../constants/files.js'
import type { ReadTextOutput } from './types.js'
import { FileTooLargeError } from './types.js'

function addLineNumbers(lines: string[], startLine: number): string {
  return lines
    .map((line, i) => `${String(startLine + i).padStart(4)}│${line}`)
    .join('\n')
}

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

  // CC parity (FileReadTool → readFileInRange): when the caller supplies
  // offset/limit, read only that window — no whole-file size gate. Without a
  // range, files larger than MAX_OUTPUT_SIZE_BYTES must use offset/limit.
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

  let lines = buf.toString('utf-8').split('\n')
  const totalLines = lines.length

  let startLine = 1
  const { offset, limit } = options ?? {}
  if (offset != null && offset < 0) {
    startLine = Math.max(1, totalLines + offset + 1)
    lines = lines.slice(startLine - 1)
  } else if (offset != null && offset > 0) {
    startLine = offset
    lines = lines.slice(offset - 1)
  }
  if (limit != null && limit > 0) lines = lines.slice(0, limit)

  const endLine = startLine + lines.length - 1
  const numbered = addLineNumbers(lines, startLine)
  const header = `${displayPath} (lines ${startLine}-${endLine} of ${totalLines})`

  return {
    type: 'text',
    file: {
      filePath: displayPath,
      content: `${header}\n${numbered}`,
      numLines: lines.length,
      startLine,
      totalLines,
    },
  }
}

/** Max bytes we'll load whole-file for @-mention truncation (streaming TBD for larger). */
const TRUNCATED_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024

/** Read first N lines when file exceeds token/line budget (attachment truncation). */
export function readTextFileTruncated(
  absPath: string,
  displayPath: string,
  options?: { offset?: number; limit?: number },
): ReadTextOutput {
  const lineLimit = options?.limit ?? MAX_LINES_TO_READ
  const offset = options?.offset ?? 1

  if (isFileWithinReadSizeLimit(absPath)) {
    return readTextFile(absPath, displayPath, { offset, limit: lineLimit })
  }

  // Oversized on disk: still attach a prefix of lines (CC @-file path). Only
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

  let lines = buf.toString('utf-8').split('\n')
  const totalLines = lines.length
  let startLine = offset
  if (offset > 0) {
    lines = lines.slice(offset - 1)
  }
  lines = lines.slice(0, lineLimit)

  const endLine = startLine + lines.length - 1
  const numbered = addLineNumbers(lines, startLine)
  const header = `${displayPath} (lines ${startLine}-${endLine} of ${totalLines})`

  return {
    type: 'text',
    file: {
      filePath: displayPath,
      content: `${header}\n${numbered}`,
      numLines: lines.length,
      startLine,
      totalLines,
    },
  }
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
