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

const JPEG_QUALITY_LADDER = [75, 55, 35, 20] as const
const RESIZE_WIDTH_LADDER = [1600, 1280, 1024, 768, 512, 384, 256] as const

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
  options?: { preferLossless?: boolean },
): Promise<{ buffer: Buffer; mediaType: ImageMediaType } | null> {
  const sharp = await loadSharp()
  if (!sharp) return null

  const metadata = await sharp(buffer).metadata()
  const sourceWidth = metadata.width ?? IMAGE_MAX_WIDTH
  const widths = [
    sourceWidth,
    ...RESIZE_WIDTH_LADDER.filter(width => width < sourceWidth),
  ]

  for (const width of widths) {
    const pipeline = () => {
      const image = sharp(buffer)
      return width < sourceWidth
        ? image.resize(width, undefined, {
            fit: 'inside',
            withoutEnlargement: true,
          })
        : image
    }

    // Charts and diagrams retain labels/lines better as palette PNG. Retry
    // after each downscale before falling back to lossy JPEG.
    if (mediaType === 'image/png' && options?.preferLossless) {
      const palette = await pipeline()
        .png({ palette: true, compressionLevel: 9 })
        .toBuffer()
      if (palette.length <= maxBytes) {
        return { buffer: palette, mediaType: 'image/png' }
      }
    }

    for (const quality of JPEG_QUALITY_LADDER) {
      const jpeg = await pipeline()
        .flatten({ background: '#ffffff' })
        .jpeg({ quality })
        .toBuffer()
      if (jpeg.length <= maxBytes) {
        return { buffer: jpeg, mediaType: 'image/jpeg' }
      }
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
  options?: { maxWidth?: number; maxHeight?: number },
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
  const maxWidth = options?.maxWidth ?? IMAGE_MAX_WIDTH
  const maxHeight = options?.maxHeight ?? IMAGE_MAX_HEIGHT
  const withinDims =
    (metadata.width ?? 0) <= maxWidth && (metadata.height ?? 0) <= maxHeight
  if (withinBytes && withinDims) {
    return { buffer, mediaType }
  }

  let working = buffer
  let workingMediaType = mediaType

  if (!withinDims) {
    working = await sharp(buffer)
      .resize(maxWidth, maxHeight, {
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
  options?: { preferLossless?: boolean; strict?: boolean },
): Promise<{ buffer: Buffer; mediaType: ImageMediaType }> {
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    throw new ImageResizeError(`Invalid image token budget: ${maxTokens}`)
  }
  const maxBase64Chars = Math.floor(maxTokens / TOKENS_PER_BASE64_CHAR)
  const maxBytes = Math.floor(maxBase64Chars * 0.75)
  if (buffer.length <= maxBytes) return { buffer, mediaType }

  const compressed = await compressToBytes(buffer, maxBytes, mediaType, options)
  if (compressed) return compressed
  if (!options?.strict) return { buffer, mediaType }
  throw new ImageResizeError(
    `Unable to compress image below ${maxTokens} estimated tokens (${maxBytes} bytes)`,
  )
}

/**
 * Convenience for tools that produce an image: resize, optionally fit a token
 * budget, and return the block to embed in `tool_result.content`.
 */
export async function toolResultImageBlockFromBuffer(
  buffer: Buffer,
  mediaType: ImageMediaType,
  options?: {
    maxTokens?: number
    maxWidth?: number
    maxHeight?: number
    preferLossless?: boolean
    strictBudget?: boolean
  },
): Promise<ImageBlockParam> {
  let result = await maybeResizeAndDownsampleImageBuffer(buffer, mediaType, {
    maxWidth: options?.maxWidth,
    maxHeight: options?.maxHeight,
  })
  if (options?.maxTokens !== undefined) {
    result = await compressImageBufferWithTokenLimit(
      result.buffer,
      options.maxTokens,
      result.mediaType,
      {
        preferLossless: options.preferLossless,
        strict: options.strictBudget,
      },
    )
  }
  return buildImageBlock(result.buffer.toString('base64'), result.mediaType)
}
