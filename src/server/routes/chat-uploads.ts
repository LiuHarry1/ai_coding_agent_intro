/**
 * POST /sessions/:id/uploads — multipart chat attachments (claim-check).
 * Field name: `file` (repeatable). Limits are per-kind, see attachment-types.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { IncomingMessage, ServerResponse } from 'http'
import multer from 'multer'
import { sendJSON } from '../http.js'
import {
  ATTACHMENT_MAX_BYTES,
  CHAT_ATTACHMENT_MAX_COUNT,
  CHAT_ATTACHMENT_MAX_TOTAL_BYTES,
  assertAttachmentSize,
  classifyAttachment,
} from '../../constants/attachment-types.js'
import { saveChatAttachment } from '../../utils/chat-uploads.js'

const MAX_ANY_BYTES = Math.max(...Object.values(ATTACHMENT_MAX_BYTES))

const uploader = multer({
  storage: multer.diskStorage({ destination: os.tmpdir() }),
  limits: {
    // multer only knows one ceiling; the per-kind gate runs after we know
    // which branch the file takes.
    fileSize: MAX_ANY_BYTES,
    files: CHAT_ATTACHMENT_MAX_COUNT,
  },
}).array('file', CHAT_ATTACHMENT_MAX_COUNT)

interface MulterFile {
  path: string
  originalname: string
  mimetype: string
  size: number
}

/**
 * Browsers send `originalname` in the client's encoding; multer decodes it as
 * latin1. Recover UTF-8 so CJK filenames survive into prompts.
 */
function decodeOriginalName(raw: string): string {
  try {
    const recovered = Buffer.from(raw, 'latin1').toString('utf8')
    return recovered.includes('\uFFFD') ? raw : recovered
  } catch {
    return raw
  }
}

export async function handleSessionChatUploads(
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
): Promise<void> {
  const declaredBytes = Number(req.headers['content-length'])
  if (
    Number.isFinite(declaredBytes) &&
    declaredBytes > CHAT_ATTACHMENT_MAX_TOTAL_BYTES + 1024 * 1024
  ) {
    sendJSON(res, 413, {
      error: `Attachments exceed the ${Math.round(CHAT_ATTACHMENT_MAX_TOTAL_BYTES / 1024 / 1024)} MB request limit`,
    })
    req.resume()
    return
  }

  let files: MulterFile[] = []
  try {
    files = await new Promise<MulterFile[]>((resolve, reject) => {
      uploader(req as any, res as any, (err: unknown) => {
        if (err) reject(err)
        else resolve(((req as any).files as MulterFile[]) || [])
      })
    })
  } catch (err) {
    const partial = (((req as any).files as MulterFile[]) || [])
    await Promise.allSettled(
      partial.map(file => fs.promises.unlink(file.path)),
    )
    sendJSON(res, 400, {
      error: err instanceof Error ? err.message : String(err),
    })
    return
  }

  const cleanup = () =>
    Promise.allSettled(files.map(f => fs.promises.unlink(f.path)))
  const persistedPaths: string[] = []

  try {
    if (files.length === 0) {
      sendJSON(res, 400, { error: 'No files in upload' })
      return
    }
    if (files.length > CHAT_ATTACHMENT_MAX_COUNT) {
      await cleanup()
      sendJSON(res, 400, {
        error: `Too many attachments (max ${CHAT_ATTACHMENT_MAX_COUNT})`,
      })
      return
    }
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
    if (totalBytes > CHAT_ATTACHMENT_MAX_TOTAL_BYTES) {
      await cleanup()
      sendJSON(res, 413, {
        error: `Attachments exceed the ${Math.round(CHAT_ATTACHMENT_MAX_TOTAL_BYTES / 1024 / 1024)} MB request limit`,
      })
      return
    }

    const saved = []
    for (const f of files) {
      const originalName = decodeOriginalName(
        path.basename(f.originalname || 'file'),
      )
      assertAttachmentSize(classifyAttachment(originalName, f.mimetype), f.size)
      const buf = await fs.promises.readFile(f.path)
      const attachment = await saveChatAttachment(sessionId, buf, {
        originalName,
        mediaType: f.mimetype,
      })
      saved.push(attachment)
      persistedPaths.push(attachment.absPath)
      await fs.promises.unlink(f.path).catch(() => {})
    }

    sendJSON(res, 200, {
      session_id: sessionId,
      // `urls` predates mixed attachments; the client still reads it for images.
      urls: saved.map(s => s.url),
      files: saved.map(s => ({
        url: s.url,
        filename: s.originalName,
        mediaType: s.mediaType,
        kind: s.kind,
        sizeBytes: s.sizeBytes,
      })),
    })
  } catch (err) {
    await cleanup()
    await Promise.allSettled(
      persistedPaths.map(file => fs.promises.unlink(file)),
    )
    if (!res.headersSent) {
      sendJSON(res, 400, {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}
