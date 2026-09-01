/**
 * POST /sessions/:id/uploads — multipart chat image attachments (claim-check).
 * Field name: `file` (repeatable). Max 5 images, 10MB each.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { IncomingMessage, ServerResponse } from 'http'
import multer from 'multer'
import { sendJSON } from '../http.js'
import {
  CHAT_UPLOAD_MAX_BYTES,
  CHAT_UPLOAD_MAX_COUNT,
  normalizeImageMediaType,
  saveChatUpload,
} from '../../utils/chat-uploads.js'

const uploader = multer({
  storage: multer.diskStorage({ destination: os.tmpdir() }),
  limits: {
    fileSize: CHAT_UPLOAD_MAX_BYTES,
    files: CHAT_UPLOAD_MAX_COUNT,
  },
}).array('file', CHAT_UPLOAD_MAX_COUNT)

interface MulterFile {
  path: string
  originalname: string
  mimetype: string
  size: number
}

function sniffMime(file: MulterFile): string {
  if (file.mimetype && file.mimetype.startsWith('image/')) {
    return file.mimetype
  }
  const ext = path.extname(file.originalname).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.webp') return 'image/webp'
  throw new Error(`Unsupported image type: ${file.mimetype || ext}`)
}

export async function handleSessionChatUploads(
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
): Promise<void> {
  const files = await new Promise<MulterFile[]>((resolve, reject) => {
    uploader(req as any, res as any, (err: unknown) => {
      if (err) reject(err)
      else resolve(((req as any).files as MulterFile[]) || [])
    })
  })

  const cleanup = () =>
    Promise.allSettled(files.map(f => fs.promises.unlink(f.path)))

  try {
    if (files.length === 0) {
      sendJSON(res, 400, { error: 'No files in upload' })
      return
    }
    if (files.length > CHAT_UPLOAD_MAX_COUNT) {
      await cleanup()
      sendJSON(res, 400, {
        error: `Too many images (max ${CHAT_UPLOAD_MAX_COUNT})`,
      })
      return
    }

    const urls: string[] = []
    for (const f of files) {
      const mime = normalizeImageMediaType(sniffMime(f))
      const buf = await fs.promises.readFile(f.path)
      const saved = await saveChatUpload(sessionId, buf, mime)
      urls.push(saved.url)
      await fs.promises.unlink(f.path).catch(() => {})
    }

    sendJSON(res, 200, { session_id: sessionId, urls })
  } catch (err) {
    await cleanup()
    if (!res.headersSent) {
      sendJSON(res, 400, {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}
