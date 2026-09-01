/**
 * Keep session JSONL free of multimodal blobs (OpenClaw claim-check).
 * Model path rehydrates screenshots from on-disk files via toolUseResult paths.
 */
import * as fs from 'fs'
import type {
  Message,
  ToolResultPart,
  ToolResultOutput,
} from '../core/types.js'
import { isRoleMessage } from '../core/types.js'
import { toolResultOutputToText } from '../utils/tool-result-content.js'

/**
 * Before appendMessage: drop image-data from tool outputs (bytes live under
 * `.sessions/{id}/browser/*.png` via screenshotPath).
 */
export function projectMessageForDisk(message: Message): Message {
  if (!isRoleMessage(message) || message.role !== 'tool') return message
  if (!Array.isArray(message.content)) return message

  let changed = false
  const content = (message.content as ToolResultPart[]).map(p => {
    if (p.type !== 'tool-result' || p.output?.type !== 'content') return p
    const hasImg = p.output.value.some(part => part.type === 'image-data')
    if (!hasImg) return p
    changed = true
    return {
      ...p,
      output: {
        type: 'text' as const,
        value: toolResultOutputToText(p.output),
      },
    }
  })

  return changed ? { ...message, content } : message
}

type ScreenshotTur = {
  screenshotPath?: string
  screenshotUrl?: string
}

function hasImageData(output: ToolResultOutput | undefined): boolean {
  return (
    !!output &&
    output.type === 'content' &&
    output.value.some(p => p.type === 'image-data')
  )
}

/**
 * After restore (or when disk projection stripped image-data), re-attach
 * screenshot bytes from `toolUseResult.screenshotPath` for the model API.
 */
export function hydrateToolResultImagesFromDisk(
  part: ToolResultPart,
): ToolResultPart {
  if (part.type !== 'tool-result' || hasImageData(part.output)) return part
  const tur = part.toolUseResult as ScreenshotTur | undefined
  const shotPath = tur?.screenshotPath
  if (!shotPath || typeof shotPath !== 'string' || !fs.existsSync(shotPath)) {
    return part
  }

  const buf = fs.readFileSync(shotPath)
  const mediaType =
    shotPath.endsWith('.jpeg') || shotPath.endsWith('.jpg')
      ? 'image/jpeg'
      : 'image/png'
  const text = toolResultOutputToText(part.output)

  return {
    ...part,
    output: {
      type: 'content',
      value: [
        { type: 'text', text },
        {
          type: 'image-data',
          data: buf.toString('base64'),
          mediaType,
        },
      ],
    },
  }
}
