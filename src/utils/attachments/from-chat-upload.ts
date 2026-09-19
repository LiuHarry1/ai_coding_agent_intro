/**
 * Composer attachments → model input.
 *
 * Every branch here converges on machinery that already exists for the Read
 * tool and `@mentions`, so a file dropped in the composer reaches the model
 * the same way `Read`ing it would:
 *
 *   image  → ImagePart on the user turn (existing `images` claim-check path)
 *   pdf    → native document part, or rasterized pages, or the text layer
 *   text   → synthetic Read tool result with line numbers + truncation
 *   binary → path only; the model reaches for Bash
 *
 * Bytes never enter the transcript: parts carry `/sessions/{id}/uploads/...`
 * or `file://` refs and are hydrated in `reviveBuffersInMessages`.
 */

import * as fs from 'fs'
import * as path from 'path'
import { pathToFileURL } from 'url'
import {
  classifyAttachment,
  formatAttachmentSize,
  isTabularExtension,
  CHAT_ATTACHMENT_MAX_COUNT,
  type AttachmentKind,
} from '../../constants/attachment-types.js'
import {
  PDF_AT_MENTION_INLINE_THRESHOLD,
  PDF_MAX_PAGES_PER_READ,
} from '../../constants/api_limits.js'
import { FILE_READ_TOOL_NAME } from '../../constants/tool_names.js'
import { isBinaryContent } from '../../constants/files.js'
import type { IProvider } from '../../core/llm/types.js'
import type {
  Message,
  UserContentPart,
  UserFileAttachment,
} from '../../core/types.js'
import { resolveChatAttachmentAbsPath, saveChatUpload } from '../chat-uploads.js'
import {
  fallbackImageForModel,
  isImageResizeError,
  maybeResizeAndDownsampleImageBuffer,
} from '../image/resize-buffer.js'
import {
  extractPDFPages,
  extractPdfText,
  formatPdfFileSize,
  getPdfPageCount,
  readPDF,
} from '../read/read-pdf.js'
import { readTextFileTruncated } from '../read/read-text.js'
import { createAttachmentMessage } from '../attachments.js'
import {
  formatTabularSummary,
  summarizeDelimitedFile,
} from './tabular-summary.js'
import {
  syntheticReadCallMessage,
  toModelFilePath,
} from './attachment-to-messages.js'
import type { Attachment } from './types.js'

/** Wire shape of one composer attachment on `POST /chat`. */
export type ChatAttachmentRef = {
  /** `/sessions/{id}/uploads/{file}` returned by the upload route. */
  url: string
  /** Name the user picked; used in prompts and UI chips. */
  filename?: string
  mediaType?: string
  sizeBytes?: number
}

export type ResolvedChatAttachments = {
  /** Upload URLs folded into the user turn by `buildUserMessage`. */
  imageRefs: string[]
  /** Meta messages injected ahead of the user turn. */
  preludeMessages: Message[]
  /** Non-image metadata persisted on the visible user message for UI reload. */
  files: UserFileAttachment[]
  /** Non-fatal problems to surface on the wire. */
  warnings: string[]
}

export function isChatAttachmentRef(value: unknown): value is ChatAttachmentRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { url?: unknown }).url === 'string'
  )
}

function metaMessage(text: string): Message {
  return { role: 'user', content: text, isMeta: true }
}

function attachmentMessage(attachment: Attachment): Message {
  return createAttachmentMessage(attachment)
}

/**
 * `classifyAttachment` is extension-driven. A `.txt` holding a protobuf dump
 * or a mislabelled upload has to be caught by looking at the bytes.
 */
function refineKind(kind: AttachmentKind, absPath: string): AttachmentKind {
  if (kind !== 'text') return kind
  try {
    const fd = fs.openSync(absPath, 'r')
    try {
      const buf = Buffer.allocUnsafe(Math.min(8192, fs.fstatSync(fd).size))
      if (buf.length === 0) return 'text'
      fs.readSync(fd, buf, 0, buf.length, 0)
      return isBinaryContent(buf) ? 'binary' : 'text'
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return kind
  }
}

async function pdfPageImageMessages(
  absPath: string,
  displayName: string,
  sessionId: string,
  firstPage: number,
  lastPage: number,
): Promise<Message[] | { error: string }> {
  const extracted = await extractPDFPages(absPath, displayName, {
    firstPage,
    lastPage,
    sessionId,
  })
  if (!extracted.success) return { error: extracted.error.message }

  const dir = extracted.data.file.outputDir
  const pages = (await fs.promises.readdir(dir))
    .filter(f => f.endsWith('.jpg'))
    .sort()

  // Composer PDF pages use the chat-image resize path (API byte/dim caps).
  // Read uses the ~25k file-read token budget + tiny-JPEG fallback.
  const messages: Message[] = []
  for (const page of pages) {
    const imgPath = path.join(dir, page)
    const raw = fs.readFileSync(imgPath)
    let resized: { buffer: Buffer; mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' }
    try {
      resized = await maybeResizeAndDownsampleImageBuffer(raw, 'image/jpeg')
    } catch (err) {
      if (!isImageResizeError(err)) throw err
      resized = await fallbackImageForModel(raw, 'image/jpeg')
    }
    const saved = await saveChatUpload(
      sessionId,
      resized.buffer,
      resized.mediaType,
    )
    messages.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text: `<system-reminder>\nPDF page from ${displayName} (${page}).\n</system-reminder>`,
        },
        {
          type: 'image',
          image: saved.url,
          mediaType: saved.mediaType,
        },
      ],
      isMeta: true,
    })
  }
  return messages
}

function pdfPrelude(
  absPath: string,
  displayName: string,
  pageCount: number | null,
  sizeText: string,
): Message[] {
  const diskPath = toModelFilePath(absPath)
  return [
    syntheticReadCallMessage(absPath),
    metaMessage(
      `The user attached ${displayName} (PDF, ${pageCount ?? '?'} pages, ${sizeText}). ` +
        `Copy or process the on-disk path ${diskPath} — do not rebuild it from the original filename.`,
    ),
  ]
}

async function resolvePdfAttachment(
  absPath: string,
  displayName: string,
  sessionId: string,
  provider: IProvider,
): Promise<{ messages: Message[]; warning?: string }> {
  const pageCount = await getPdfPageCount(absPath)
  const sizeText = formatPdfFileSize(fs.statSync(absPath).size)
  const header = pdfPrelude(absPath, displayName, pageCount, sizeText)
  const diskPath = toModelFilePath(absPath)

  if (provider.supportsNativePdf?.() === true) {
    const result = await readPDF(absPath, displayName)
    if (result.success) {
      const parts: UserContentPart[] = [
        { type: 'text', text: `Attached PDF: ${displayName}` },
        {
          type: 'file',
          data: pathToFileURL(absPath).href,
          mediaType: 'application/pdf',
          filename: displayName,
        },
      ]
      return {
        messages: [
          ...header,
          { role: 'user', content: parts, isMeta: true },
        ],
      }
    }
    // Oversized/corrupt for a document block — fall through to page images.
  }

  if (provider.supportsImageInput?.() !== false) {
    const lastPage = Math.min(
      pageCount ?? PDF_AT_MENTION_INLINE_THRESHOLD,
      PDF_MAX_PAGES_PER_READ,
    )
    const pages = await pdfPageImageMessages(
      absPath,
      displayName,
      sessionId,
      1,
      lastPage,
    )
    if (Array.isArray(pages) && pages.length > 0) {
      const messages = [...header, ...pages]
      if (pageCount != null && pageCount > lastPage) {
        messages.push(
          metaMessage(
            `Only pages 1-${lastPage} of ${displayName} are shown. Use ${FILE_READ_TOOL_NAME} with ` +
              `file_path ${JSON.stringify(diskPath)} and the pages parameter (max ${PDF_MAX_PAGES_PER_READ} per call) to see the rest.`,
          ),
        )
      }
      return { messages }
    }
  }

  const text = await extractPdfText(absPath)
  if (text) {
    return {
      messages: [
        ...header,
        metaMessage(
          `Text layer extracted from ${displayName} (page images unavailable, layout is lost):\n\n${text}`,
        ),
      ],
      warning: `${displayName}: rendered pages unavailable, used the PDF text layer instead.`,
    }
  }

  return {
    messages: [
      ...header,
      metaMessage(
        `${displayName} could not be converted for this model — no PDF document support, no page renderer (poppler), and no text layer. ` +
          `The raw file is at ${diskPath} if a shell tool can help.`,
      ),
    ],
    warning: `${displayName}: could not be read (install poppler-utils for PDF page rendering).`,
  }
}

function resolveTextAttachment(
  absPath: string,
  displayName: string,
): { messages: Message[]; warning?: string } {
  try {
    const output = readTextFileTruncated(absPath, displayName)
    const truncated = output.file.totalLines > output.file.numLines

    let note: string | undefined
    if (isTabularExtension(displayName)) {
      const summary = summarizeDelimitedFile(absPath)
      if (summary) {
        note = formatTabularSummary(
          summary,
          displayName,
          toModelFilePath(absPath),
        )
      }
    }
    note ??=
      `${displayName} is on disk at ${toModelFilePath(absPath)}. ` +
      `Copy or process that on-disk path; do not rebuild it from the original filename.`

    return {
      messages: [
        attachmentMessage({
          type: 'file',
          filename: absPath,
          displayPath: displayName,
          content: output,
          truncated,
          note,
        }),
      ],
    }
  } catch (err) {
    const size = fs.existsSync(absPath) ? fs.statSync(absPath).size : 0
    return {
      messages: [
        attachmentMessage({
          type: 'uploaded_binary',
          filename: absPath,
          displayPath: displayName,
          mediaType: 'application/octet-stream',
          fileSize: size,
        }),
      ],
      warning: `${displayName}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/**
 * Turn inbound composer attachment refs into image refs + prelude messages.
 * Unreadable attachments degrade to a note rather than failing the turn.
 */
export async function resolveChatAttachments(
  refs: ChatAttachmentRef[] | undefined,
  opts: { sessionId: string; provider: IProvider },
): Promise<ResolvedChatAttachments> {
  const result: ResolvedChatAttachments = {
    imageRefs: [],
    preludeMessages: [],
    files: [],
    warnings: [],
  }
  if (!refs?.length) return result
  if (refs.length > CHAT_ATTACHMENT_MAX_COUNT) {
    throw new Error(
      `Too many attachments (max ${CHAT_ATTACHMENT_MAX_COUNT})`,
    )
  }

  for (const ref of refs) {
    const absPath = resolveChatAttachmentAbsPath(ref.url, opts.sessionId)
    if (!absPath || !fs.existsSync(absPath)) {
      result.warnings.push(`Attachment not found: ${ref.filename ?? ref.url}`)
      continue
    }

    const displayName = ref.filename || path.basename(absPath)
    const kind = refineKind(
      classifyAttachment(displayName, ref.mediaType),
      absPath,
    )
    if (kind !== 'image') {
      result.files.push({
        name: displayName,
        kind,
        size: fs.statSync(absPath).size,
      })
    }

    try {
      if (kind === 'image') {
        if (opts.provider.supportsImageInput?.() === false) {
          result.warnings.push(
            `${displayName}: the active model has no image input; attachment skipped.`,
          )
          result.preludeMessages.push(
            metaMessage(
              `The user attached the image ${displayName}, but this model cannot see images. Say so instead of guessing at its contents.`,
            ),
          )
          continue
        }
        result.imageRefs.push(ref.url)
        continue
      }

      if (kind === 'pdf') {
        const { messages, warning } = await resolvePdfAttachment(
          absPath,
          displayName,
          opts.sessionId,
          opts.provider,
        )
        result.preludeMessages.push(...messages)
        if (warning) result.warnings.push(warning)
        continue
      }

      if (kind === 'text') {
        const { messages, warning } = resolveTextAttachment(absPath, displayName)
        result.preludeMessages.push(...messages)
        if (warning) result.warnings.push(warning)
        continue
      }

      result.preludeMessages.push(
        attachmentMessage({
          type: 'uploaded_binary',
          filename: absPath,
          displayPath: displayName,
          mediaType: ref.mediaType ?? 'application/octet-stream',
          fileSize: ref.sizeBytes ?? fs.statSync(absPath).size,
        }),
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      result.warnings.push(`${displayName}: ${msg}`)
      result.preludeMessages.push(
        metaMessage(
          `The user attached ${displayName} (${formatAttachmentSize(ref.sizeBytes ?? 0)}) but it could not be processed: ${msg}. The file is at ${toModelFilePath(absPath)}.`,
        ),
      )
    }
  }

  return result
}
