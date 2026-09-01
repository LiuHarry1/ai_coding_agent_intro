/**
 * Chat image attachments — OpenClaw-style claim-check.
 *
 * Bytes live under `.sessions/{id}/uploads/`; transcript + UI keep short
 * `/sessions/{id}/uploads/{file}` refs (never multi-MB base64 / Buffer arrays).
 */

import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { getSessionDataDir } from '../core/session-paths.js'
import type { ImageMediaType } from '../core/types.js'

export const CHAT_UPLOAD_MAX_BYTES = 10 * 1024 * 1024
export const CHAT_UPLOAD_MAX_COUNT = 5

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

const EXT_TO_MIME: Record<string, ImageMediaType> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/** Filename allowlist for GET /sessions/:id/uploads/:file */
export const CHAT_UPLOAD_FILE_RE = /^[A-Za-z0-9_-]+\.(png|jpeg|gif|webp)$/

export function normalizeImageMediaType(raw: string): ImageMediaType {
  const mime = raw.toLowerCase().split(';')[0]!.trim()
  if (mime === 'image/jpg') return 'image/jpeg'
  if (
    mime === 'image/png' ||
    mime === 'image/jpeg' ||
    mime === 'image/gif' ||
    mime === 'image/webp'
  ) {
    return mime
  }
  throw new Error(`Unsupported image type: ${raw}`)
}

export function extForMediaType(mediaType: string): string {
  const mime = normalizeImageMediaType(mediaType)
  return MIME_TO_EXT[mime] ?? 'png'
}

export function mediaTypeForExt(ext: string): ImageMediaType {
  const e = ext.replace(/^\./, '').toLowerCase()
  const mime = EXT_TO_MIME[e]
  if (!mime) throw new Error(`Unsupported image extension: ${ext}`)
  return mime
}

export function chatUploadUrl(sessionId: string, fileName: string): string {
  return `/sessions/${encodeURIComponent(sessionId)}/uploads/${fileName}`
}

export function getChatUploadsDir(sessionId: string): string {
  return path.join(getSessionDataDir(sessionId), 'uploads')
}

/** Match `/sessions/{id}/uploads/{file}` (encoded or plain id). */
export function parseChatUploadUrl(
  ref: string,
): { sessionId: string; fileName: string } | null {
  const m = ref.match(/^\/sessions\/([^/]+)\/uploads\/([^/]+)$/)
  if (!m) return null
  const sessionId = decodeURIComponent(m[1]!)
  const fileName = decodeURIComponent(m[2]!)
  if (!CHAT_UPLOAD_FILE_RE.test(fileName)) return null
  return { sessionId, fileName }
}

export function parseDataUrl(dataUrl: string): {
  buffer: Buffer
  mediaType: ImageMediaType
} {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/s)
  if (!match) throw new Error('Invalid data URL')
  const mediaType = normalizeImageMediaType(match[1]!)
  const buffer = Buffer.from(match[2]!, 'base64')
  return { buffer, mediaType }
}

export function assertChatUploadSize(bytes: number): void {
  if (bytes <= 0) throw new Error('Empty image')
  if (bytes > CHAT_UPLOAD_MAX_BYTES) {
    throw new Error(
      `Image too large (${bytes} bytes; max ${CHAT_UPLOAD_MAX_BYTES})`,
    )
  }
}

export type SavedChatUpload = {
  fileName: string
  url: string
  absPath: string
  mediaType: ImageMediaType
  sizeBytes: number
}

export async function saveChatUpload(
  sessionId: string,
  buffer: Buffer,
  mediaType: string,
): Promise<SavedChatUpload> {
  assertChatUploadSize(buffer.byteLength)
  const mime = normalizeImageMediaType(mediaType)
  const ext = extForMediaType(mime)
  const dir = getChatUploadsDir(sessionId)
  await fsp.mkdir(dir, { recursive: true })
  const fileName = `${randomUUID().replace(/-/g, '')}.${ext}`
  const absPath = path.join(dir, fileName)
  await fsp.writeFile(absPath, buffer)
  return {
    fileName,
    url: chatUploadUrl(sessionId, fileName),
    absPath,
    mediaType: mime,
    sizeBytes: buffer.byteLength,
  }
}

/**
 * Turn inbound chat `images[]` (data URLs or existing upload URLs) into durable
 * session upload URLs. Idempotent for refs already under this session.
 */
export async function offloadChatImageRefs(
  sessionId: string,
  images: string[] | undefined,
): Promise<string[]> {
  if (!images?.length) return []
  if (images.length > CHAT_UPLOAD_MAX_COUNT) {
    throw new Error(`Too many images (max ${CHAT_UPLOAD_MAX_COUNT})`)
  }

  const out: string[] = []
  for (const raw of images) {
    if (typeof raw !== 'string' || !raw) {
      throw new Error('Invalid image attachment')
    }
    const existing = parseChatUploadUrl(raw)
    if (existing) {
      if (existing.sessionId !== sessionId) {
        throw new Error('Image upload belongs to another session')
      }
      const abs = path.join(
        getChatUploadsDir(sessionId),
        existing.fileName,
      )
      if (!fs.existsSync(abs)) {
        throw new Error(`Missing upload file: ${existing.fileName}`)
      }
      out.push(chatUploadUrl(sessionId, existing.fileName))
      continue
    }
    if (raw.startsWith('data:')) {
      const { buffer, mediaType } = parseDataUrl(raw)
      const saved = await saveChatUpload(sessionId, buffer, mediaType)
      out.push(saved.url)
      continue
    }
    throw new Error(
      'Unsupported image ref (expected data URL or /sessions/.../uploads/...)',
    )
  }
  return out
}

/** Absolute path for a chat upload URL, or null if not a valid upload ref. */
export function resolveChatUploadAbsPath(ref: string): string | null {
  const parsed = parseChatUploadUrl(ref)
  if (!parsed) return null
  const abs = path.resolve(
    getChatUploadsDir(parsed.sessionId),
    parsed.fileName,
  )
  const root = path.resolve(getChatUploadsDir(parsed.sessionId))
  if (abs !== root && !abs.startsWith(root + path.sep)) return null
  return abs
}

/**
 * Load bytes for an ImagePart.image value (upload URL, file://, data URL, or Buffer).
 * Used when projecting history to the model API.
 */
export function hydrateImageBytes(
  image: string | Buffer | Uint8Array,
  mediaType?: string,
): { buffer: Buffer; mediaType: ImageMediaType } {
  if (Buffer.isBuffer(image)) {
    return {
      buffer: image,
      mediaType: mediaType
        ? normalizeImageMediaType(mediaType)
        : 'image/png',
    }
  }
  if (image instanceof Uint8Array) {
    return {
      buffer: Buffer.from(image),
      mediaType: mediaType
        ? normalizeImageMediaType(mediaType)
        : 'image/png',
    }
  }
  if (typeof image === 'string') {
    if (image.startsWith('data:')) {
      return parseDataUrl(image)
    }
    if (image.startsWith('file:')) {
      const abs = fileURLToPath(image)
      if (!fs.existsSync(abs)) {
        throw new Error(`Missing file image: ${abs}`)
      }
      const ext = path.extname(abs).slice(1)
      return {
        buffer: fs.readFileSync(abs),
        mediaType: mediaType
          ? normalizeImageMediaType(mediaType)
          : mediaTypeForExt(ext || 'png'),
      }
    }
    const abs = resolveChatUploadAbsPath(image)
    if (abs && fs.existsSync(abs)) {
      const ext = path.extname(abs).slice(1)
      return {
        buffer: fs.readFileSync(abs),
        mediaType: mediaType
          ? normalizeImageMediaType(mediaType)
          : mediaTypeForExt(ext),
      }
    }
  }
  throw new Error('Unable to hydrate image attachment')
}

export function mimeFromUploadFileName(fileName: string): string {
  const ext = path.extname(fileName).slice(1)
  return mediaTypeForExt(ext)
}
