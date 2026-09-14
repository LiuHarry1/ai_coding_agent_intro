import * as fs from 'fs'
import {
  READ_IMAGE_MAX_HEIGHT,
  READ_IMAGE_MAX_WIDTH,
  READ_IMAGE_TOKEN_BUDGET,
} from '../../constants/api_limits.js'
import type { ReadImageOutput } from './types.js'
import {
  ImageResizeError,
  toolResultImageBlockFromBuffer,
} from '../image/resize-buffer.js'

const MEDIA_BY_EXT: Record<string, ReadImageOutput['file']['mediaType']> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

function detectMediaType(ext: string): ReadImageOutput['file']['mediaType'] {
  return MEDIA_BY_EXT[ext.toLowerCase()] ?? 'image/png'
}

/** CC FileReadTool last resort when token-budget compression still fails. */
async function fallbackTinyJpeg(raw: Buffer): Promise<{
  base64: string
  mediaType: 'image/jpeg'
}> {
  const sharp = (await import('sharp')).default
  const buffer = await sharp(raw)
    .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 20 })
    .toBuffer()
  return { base64: buffer.toString('base64'), mediaType: 'image/jpeg' }
}

export async function readImageFile(
  absPath: string,
  displayPath: string,
): Promise<ReadImageOutput> {
  if (!fs.existsSync(absPath)) {
    throw new Error(`file not found: ${displayPath}`)
  }
  const stat = fs.statSync(absPath)
  if (stat.size === 0) {
    throw new Error(`image file is empty: ${displayPath}`)
  }

  const ext = displayPath.includes('.')
    ? displayPath.slice(displayPath.lastIndexOf('.') + 1)
    : 'png'
  const raw = fs.readFileSync(absPath)
  const mediaType = detectMediaType(ext)

  try {
    const image = await toolResultImageBlockFromBuffer(raw, mediaType, {
      maxTokens: READ_IMAGE_TOKEN_BUDGET,
      maxWidth: READ_IMAGE_MAX_WIDTH,
      maxHeight: READ_IMAGE_MAX_HEIGHT,
      preferLossless: mediaType === 'image/png',
      strictBudget: true,
    })
    return {
      type: 'image',
      file: {
        filePath: displayPath,
        base64: image.source.data,
        mediaType: image.source.media_type,
        originalSize: stat.size,
      },
    }
  } catch (err) {
    if (!(err instanceof ImageResizeError)) throw err
    // Prefer a tiny readable image over failing the Read tool (CC parity).
    try {
      const tiny = await fallbackTinyJpeg(raw)
      return {
        type: 'image',
        file: {
          filePath: displayPath,
          base64: tiny.base64,
          mediaType: tiny.mediaType,
          originalSize: stat.size,
        },
      }
    } catch {
      throw err
    }
  }
}
