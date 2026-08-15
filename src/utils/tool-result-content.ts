/**
 * Helpers for tool results whose content is CC-style blocks rather than a
 * plain string (`ToolResultBlockParam.content: string | blocks[]`).
 *
 * Two projections exist for every result:
 *   - blocks  → what the model receives (`ToolResultOutput.type = 'content'`)
 *   - text    → what the wire, transcript UI, compaction and token estimation
 *               receive; images collapse to `[image]` so base64 never leaks
 *               into those paths.
 */
import type {
  Base64ImageSource,
  ImageBlockParam,
  ImageMediaType,
  ToolResultContentBlockParam,
  ToolResultOutput,
  ToolResultOutputContentPart,
} from '../core/types.js'

export const IMAGE_TEXT_PLACEHOLDER = '[image]'

export function buildImageBlock(
  base64: string,
  mediaType: ImageMediaType,
): ImageBlockParam {
  const source: Base64ImageSource = {
    type: 'base64',
    media_type: mediaType,
    data: base64,
  }
  return { type: 'image', source }
}

export function hasImageBlock(
  content: string | ToolResultContentBlockParam[],
): boolean {
  return (
    Array.isArray(content) && content.some(block => block.type === 'image')
  )
}

/** CC: `is_error` tool_results must contain only text blocks. */
export function stripImageBlocks(
  blocks: ToolResultContentBlockParam[],
): ToolResultContentBlockParam[] {
  return blocks.filter(block => block.type !== 'image')
}

export function toolResultBlocksToText(
  blocks: ToolResultContentBlockParam[],
): string {
  return blocks
    .map(block =>
      block.type === 'text' ? block.text : IMAGE_TEXT_PLACEHOLDER,
    )
    .filter(Boolean)
    .join('\n')
}

/** Model-facing output parts for the AI SDK. */
export function blocksToToolResultOutputParts(
  blocks: ToolResultContentBlockParam[],
): ToolResultOutputContentPart[] {
  return blocks.map(block =>
    block.type === 'text'
      ? { type: 'text' as const, text: block.text }
      : {
          type: 'image-data' as const,
          data: block.source.data,
          mediaType: block.source.media_type,
        },
  )
}

/**
 * Text projection of any tool output. Use anywhere a result is treated as a
 * string (transcript, compaction, persistence, error sniffing).
 */
export function toolResultOutputToText(
  output: ToolResultOutput | undefined,
): string {
  if (!output) return ''
  if (output.type === 'text') return output.value
  return output.value
    .map(part =>
      part.type === 'text' ? part.text : IMAGE_TEXT_PLACEHOLDER,
    )
    .filter(Boolean)
    .join('\n')
}

export function countOutputImages(output: ToolResultOutput | undefined): number {
  if (!output || output.type !== 'content') return 0
  return output.value.filter(part => part.type === 'image-data').length
}
