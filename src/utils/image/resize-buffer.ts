/**
 * Buffer-level image downscaling for tool results, ported from CC's
 * `utils/imageResizer.ts`. `read-image.ts` covers the file-read path; this
 * covers images a tool produces in memory (screenshots, canvas exports).
 *
 * sharp is imported dynamically so the agent still runs when the optional
 * native binary is unavailable — callers get the original buffer back if it
 * already fits the API limits, and an error only when it genuinely can't.
 */
import {
  API_IMAGE_MAX_BASE64_SIZE,
  IMAGE_MAX_HEIGHT,
  IMAGE_MAX_WIDTH,
  IMAGE_TARGET_RAW_SIZE,
} from '../../constants/api_limits.js'
import type { ImageBlockParam, ImageMediaType } from '../../core/types.js'
import { buildImageBlock } from '../tool-result-content.js'

/** Base64 chars per token, matching CC's `base64.length * 0.125` estimate. */
const TOKENS_PER_BASE64_CHAR = 0.125

const JPEG_QUALITY_LADDER = [80, 60, 40, 20] as const

export class ImageResizeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImageResizeError'
  }
}

type Sharp = typeof import('sharp')

async function loadSharp(): Promise<Sharp | null> {
  try {
    return (await import('sharp')).default as unknown as Sharp
  } catch {
    return null
  }
}

function base64Length(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4
}

export function estimateImageTokens(base64: string): number {
  return Math.ceil(base64.length * TOKENS_PER_BASE64_CHAR)
}

async function compressToBytes(
  buffer: Buffer,
  maxBytes: number,
  mediaType: ImageMediaType,
): Promise<{ buffer: Buffer; mediaType: ImageMediaType } | null> {
  const sharp = await loadSharp()
  if (!sharp) return null

  if (mediaType === 'image/png') {
    const palette = await sharp(buffer)
      .png({ palette: true, compressionLevel: 9 })
      .toBuffer()
    if (palette.length <= maxBytes) {
      return { buffer: palette, mediaType: 'image/png' }
    }
  }

  for (const quality of JPEG_QUALITY_LADDER) {
    const jpeg = await sharp(buffer).jpeg({ quality }).toBuffer()
    if (jpeg.length <= maxBytes) {
      return { buffer: jpeg, mediaType: 'image/jpeg' }
    }
  }
  return null
}

/**
 * Bring a buffer under the API's 5MB base64 / 2000px limits. Returns the
 * input untouched when it already fits (CC's fast path).
 */
export async function maybeResizeAndDownsampleImageBuffer(
  buffer: Buffer,
  mediaType: ImageMediaType,
): Promise<{ buffer: Buffer; mediaType: ImageMediaType }> {
  if (buffer.length === 0) {
    throw new ImageResizeError('Image is empty (0 bytes)')
  }

  const sharp = await loadSharp()
  if (!sharp) {
    if (base64Length(buffer.length) <= API_IMAGE_MAX_BASE64_SIZE) {
      return { buffer, mediaType }
    }
    throw new ImageResizeError(
      `Image is ${(buffer.length / 1024 / 1024).toFixed(1)}MB and exceeds the ${
        API_IMAGE_MAX_BASE64_SIZE / 1024 / 1024
      }MB API limit. Install sharp for auto-resize or produce a smaller image.`,
    )
  }

  const metadata = await sharp(buffer).metadata()
  const withinBytes = buffer.length <= IMAGE_TARGET_RAW_SIZE
  const withinDims =
    (metadata.width ?? 0) <= IMAGE_MAX_WIDTH &&
    (metadata.height ?? 0) <= IMAGE_MAX_HEIGHT
  if (withinBytes && withinDims) {
    return { buffer, mediaType }
  }

  let working = buffer
  let workingMediaType = mediaType

  if (!withinDims) {
    working = await sharp(buffer)
      .resize(IMAGE_MAX_WIDTH, IMAGE_MAX_HEIGHT, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .toBuffer()
  }

  if (working.length <= IMAGE_TARGET_RAW_SIZE) {
    return { buffer: working, mediaType: workingMediaType }
  }

  const compressed = await compressToBytes(
    working,
    IMAGE_TARGET_RAW_SIZE,
    workingMediaType,
  )
  if (compressed) return compressed

  // Last resort, matching CC: hard-shrink to 1000px wide at the lowest quality.
  const shrunk = await sharp(working)
    .resize(1000, undefined, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 20 })
    .toBuffer()
  if (base64Length(shrunk.length) <= API_IMAGE_MAX_BASE64_SIZE) {
    return { buffer: shrunk, mediaType: 'image/jpeg' }
  }

  throw new ImageResizeError(
    `Unable to compress image below the ${
      API_IMAGE_MAX_BASE64_SIZE / 1024 / 1024
    }MB API limit. Produce a smaller image.`,
  )
}

/** CC `compressImageBufferWithTokenLimit`: budget expressed in model tokens. */
export async function compressImageBufferWithTokenLimit(
  buffer: Buffer,
  maxTokens: number,
  mediaType: ImageMediaType,
): Promise<{ buffer: Buffer; mediaType: ImageMediaType }> {
  const maxBase64Chars = Math.floor(maxTokens / TOKENS_PER_BASE64_CHAR)
  const maxBytes = Math.floor(maxBase64Chars * 0.75)
  if (buffer.length <= maxBytes) return { buffer, mediaType }

  const compressed = await compressToBytes(buffer, maxBytes, mediaType)
  return compressed ?? { buffer, mediaType }
}

/**
 * Convenience for tools that produce an image: resize, optionally fit a token
 * budget, and return the block to embed in `tool_result.content`.
 */
export async function toolResultImageBlockFromBuffer(
  buffer: Buffer,
  mediaType: ImageMediaType,
  options?: { maxTokens?: number },
): Promise<ImageBlockParam> {
  let result = await maybeResizeAndDownsampleImageBuffer(buffer, mediaType)
  if (options?.maxTokens !== undefined) {
    result = await compressImageBufferWithTokenLimit(
      result.buffer,
      options.maxTokens,
      result.mediaType,
    )
  }
  return buildImageBlock(result.buffer.toString('base64'), result.mediaType)
}
