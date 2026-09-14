/**
 * Composer attachment classification.
 *
 * A file dropped in the composer takes the same branch the Read tool would
 * take for it (`utils/read/index.ts`): image, pdf, text, or opaque binary.
 * Classification is extension-first like Claude Code; callers sniff content
 * afterwards and downgrade `text` → `binary` when the bytes disagree.
 */

import { hasBinaryExtension } from './files.js'
import { isImageExtension, isPdfExtension } from './api_limits.js'

export type AttachmentKind = 'image' | 'pdf' | 'text' | 'binary'

export const CHAT_ATTACHMENT_MAX_COUNT = 10
/** Aggregate ceiling per multipart request, independent of per-kind limits. */
export const CHAT_ATTACHMENT_MAX_TOTAL_BYTES = 128 * 1024 * 1024

/**
 * Per-kind upload ceilings. Images stay at the API's 5 MB base64 budget with
 * headroom for pre-resize originals; PDFs match `PDF_TARGET_RAW_SIZE`; text is
 * capped well above the 256 KB read window so truncation (not rejection) is
 * what the user sees; binaries only need to land on disk for Bash.
 */
export const ATTACHMENT_MAX_BYTES: Record<AttachmentKind, number> = {
  image: 10 * 1024 * 1024,
  pdf: 20 * 1024 * 1024,
  text: 16 * 1024 * 1024,
  binary: 64 * 1024 * 1024,
}

/** Extensions that get a real media type on the wire; everything else is text/plain. */
const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  md: 'text/markdown',
  html: 'text/html',
  htm: 'text/html',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  log: 'text/plain',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
}

const TABULAR_EXTENSIONS = new Set(['csv', 'tsv'])

/**
 * Media types the ImagePart pipeline can actually carry. Everything else the
 * browser labels `image/*` (bmp, tiff, heic, avif) has no place in it: the
 * saved name drives the media type in `buildUserMessage`, so storing such
 * bytes under an image extension would reach the model as a corrupt image.
 */
const SUPPORTED_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
])

/** `image/*` formats that are really text the model can read and edit. */
const TEXTUAL_IMAGE_EXTENSIONS = new Set(['svg'])

export function normalizeExt(fileNameOrExt: string): string {
  const dot = fileNameOrExt.lastIndexOf('.')
  const ext = dot === -1 ? fileNameOrExt : fileNameOrExt.slice(dot + 1)
  return ext.toLowerCase()
}

export function isTabularExtension(fileName: string): boolean {
  return TABULAR_EXTENSIONS.has(normalizeExt(fileName))
}

/**
 * Media type for an uploaded file. A caller-supplied browser hint wins only
 * when the extension is unknown — browsers routinely report `text/csv` files
 * as `application/vnd.ms-excel`, and Windows reports `.md` as empty.
 */
export function attachmentMediaType(fileName: string, hint?: string): string {
  const known = EXT_TO_MIME[normalizeExt(fileName)]
  if (known) return known
  const clean = hint?.toLowerCase().split(';')[0]?.trim()
  if (clean && clean !== 'application/octet-stream') return clean
  return 'text/plain'
}

export function classifyAttachment(fileName: string, hint?: string): AttachmentKind {
  const ext = normalizeExt(fileName)
  const mime = attachmentMediaType(fileName, hint)

  if (isImageExtension(ext) || SUPPORTED_IMAGE_MIMES.has(mime)) return 'image'
  if (isPdfExtension(ext) || mime === 'application/pdf') return 'pdf'
  if (TEXTUAL_IMAGE_EXTENSIONS.has(ext)) return 'text'
  // An unsupported image format is handed over as a path; the model converts
  // it with a shell tool instead of receiving bytes it cannot decode.
  if (mime.startsWith('image/')) return 'binary'
  // `.` -less names (Makefile, Dockerfile) and unknown extensions read as text.
  if (hasBinaryExtension(`.${ext}`)) return 'binary'
  return 'text'
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function assertAttachmentSize(kind: AttachmentKind, bytes: number): void {
  if (bytes <= 0) throw new Error('Empty attachment')
  const max = ATTACHMENT_MAX_BYTES[kind]
  if (bytes > max) {
    throw new Error(
      `Attachment too large (${formatAttachmentSize(bytes)}; max ${formatAttachmentSize(max)} for ${kind} files)`,
    )
  }
}
