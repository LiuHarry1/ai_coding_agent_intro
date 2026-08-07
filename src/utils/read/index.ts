import * as path from 'path'
import {
  isImageExtension,
  isNotebookExtension,
  isPdfExtension,
} from '../../constants/api_limits.js'
import { isReadableInternalPath } from '../../core/session-paths.js'
import { fileExtension, formatTextReadForModel, readTextFile } from './read-text.js'
import { readImageFile } from './read-image.js'
import { readNotebookFile } from './read-notebook.js'
import { readPdfFile } from './read-pdf.js'
import type { ReadImageOutput, ReadOutput } from './types.js'
import type { Message, UserContentPart } from '../../core/types.js'
import { formatTextReadBoundaryReminder } from './boundary-reminders.js'
import { FILE_UNCHANGED_STUB } from './read-file-state.js'

export interface ReadFileOptions {
  offset?: number
  limit?: number
  pages?: string
}

export interface ReadFileResult {
  output: ReadOutput
  /** Extra user messages for multimodal content (images/PDF), `newMessages` pattern. */
  followUpMessages?: Message[]
}

export function resolveFileInCwd(
  cwd: string,
  filePath: string,
): { abs: string; displayPath: string } | { error: string } {
  const abs = path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(cwd, filePath)
  const rel = path.relative(cwd, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    // Claude Code: task output / tool-results live outside project cwd but
    // are auto-allowed for Read (checkReadableInternalPath / project temp).
    if (isReadableInternalPath(abs)) {
      return { abs, displayPath: path.basename(abs) }
    }
    return { error: `Path escapes workspace: ${filePath}` }
  }
  const displayPath = rel.split(path.sep).join('/') || path.basename(abs)
  return { abs, displayPath }
}

export async function readFileCore(
  cwd: string,
  filePath: string,
  options?: ReadFileOptions,
): Promise<ReadFileResult> {
  const resolved = resolveFileInCwd(cwd, filePath)
  if ('error' in resolved) throw new Error(resolved.error)
  const { abs, displayPath } = resolved
  const ext = fileExtension(abs)

  if (isNotebookExtension(ext)) {
    return { output: readNotebookFile(abs, displayPath) }
  }
  if (isImageExtension(ext)) {
    const output = await readImageFile(abs, displayPath)
    const followUp = buildImageFollowUp(output)
    return { output, followUpMessages: followUp ? [followUp] : undefined }
  }
  if (isPdfExtension(ext)) {
    const output = await readPdfFile(abs, displayPath, options?.pages)
    if (output.type === 'pdf') {
      return {
        output,
        followUpMessages: [
          {
            role: 'user',
            content: wrapReminder(
              `PDF file attached from Read (${displayPath}, ${output.file.pageCount ?? '?'} pages).`,
            ),
          },
        ],
      }
    }
    return { output }
  }

  return {
    output: readTextFile(abs, displayPath, {
      offset: options?.offset,
      limit: options?.limit,
    }),
  }
}

function wrapReminder(text: string): string {
  return `<system-reminder>\n${text}\n</system-reminder>`
}

function buildImageFollowUp(output: ReadImageOutput): Message | null {
  const parts: UserContentPart[] = [
    {
      type: 'text',
      text: wrapReminder(
        `Image from Read: ${output.file.filePath} (${output.file.mediaType}, ${output.file.originalSize} bytes).`,
      ),
    },
    {
      type: 'image',
      image: Buffer.from(output.file.base64, 'base64'),
      mediaType: output.file.mediaType,
    },
  ]
  return { role: 'user', content: parts }
}

/** Format Read output as tool result string (for agent tool execute / LLM path). */
export function formatReadOutputAsToolString(output: ReadOutput): string {
  switch (output.type) {
    case 'file_unchanged':
      return FILE_UNCHANGED_STUB
    case 'text':
      // Empty content is the dual-channel signal for empty file / offset OOB —
      // map to a short system-reminder for the model (not malware mitigation).
      if (!output.file.content) {
        return formatTextReadBoundaryReminder(output.file)
      }
      // Out stores raw lines; line numbers / header only on the model path.
      return formatTextReadForModel(output.file)
    case 'image':
      return `[Image: ${output.file.filePath}, ${output.file.mediaType}, ${output.file.originalSize} bytes — image attached in follow-up message]`
    case 'notebook':
      return `${output.file.filePath} (${output.file.cells.length} cells)\n${JSON.stringify(output.file.cells, null, 2)}`
    case 'pdf':
      return `[PDF: ${output.file.filePath}, ${output.file.originalSize} bytes, ${output.file.pageCount ?? '?'} pages — document context attached]`
    case 'pdf_pages':
      return output.file.text
  }
}

export type { ReadOutput, ReadFileState, ReadFileStateEntry } from './types.js'
export {
  FileTooLargeError,
  MaxFileReadLinesExceededError,
  MaxFileReadTokenExceededError,
  ReadOutputSchema,
} from './types.js'
export {
  EMPTY_FILE_READ_REMINDER,
  FILE_UNCHANGED_STUB,
  formatTextReadBoundaryReminder,
  offsetBeyondEofReminder,
} from './boundary-reminders.js'
export {
  clearReadFileState,
  invalidateReadPaths,
  recordReadInState,
  recordWriteInState,
  shouldDedupRead,
} from './read-file-state.js'
export {
  formatTextReadForModel,
  addLineNumbers,
  roughTokenEstimate,
} from './read-text.js'
export { readTextFromString } from './read-from-string.js'
export {
  findSimilarFile,
  suggestPathUnderCwd,
  formatFileNotFoundMessage,
} from './path-suggest.js'
