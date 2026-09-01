/**
 * Single projection for `tool_use_result` on the wire / session / UI.
 *
 * Call at execute time (`projectToolUseResult`). Session hydrate only
 * re-projects blobs that still look pre-cap (old JSONL).
 */
import {
  BROWSER_TOOL_NAMES,
  FILE_READ_TOOL_NAME,
} from '../constants/tool_names.js'
import { projectBrowserWireDetails } from '../tools/BrowserTool/shared.js'
import { projectReadWireDetails } from './read/project-wire.js'

export function projectToolUseResult(
  toolName: string | undefined,
  data: unknown,
): unknown {
  if (data === undefined) return undefined
  if (
    typeof toolName === 'string' &&
    (BROWSER_TOOL_NAMES as readonly string[]).includes(toolName)
  ) {
    return projectBrowserWireDetails(data)
  }
  if (toolName === FILE_READ_TOOL_NAME) {
    return projectReadWireDetails(data)
  }
  if (looksLikeFatBrowserResult(data)) {
    return projectBrowserWireDetails(data)
  }
  if (looksLikeFatReadResult(data)) {
    return projectReadWireDetails(data)
  }
  return data
}

/**
 * Session / UI hydrate: new writes are already slim. Only squeeze leftover
 * snapshot strings and file bodies from older JSONL.
 */
export function projectLegacyFatToolUseResult(
  toolName: string | undefined,
  data: unknown,
): unknown {
  if (data === undefined) return undefined
  if (!looksLikeFatBrowserResult(data) && !looksLikeFatReadResult(data)) {
    return data
  }
  return projectToolUseResult(toolName, data)
}

function looksLikeFatBrowserResult(data: unknown): boolean {
  return (
    !!data &&
    typeof data === 'object' &&
    typeof (data as { snapshot?: unknown }).snapshot === 'string'
  )
}

function looksLikeFatReadResult(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false
  const file = (data as { file?: unknown }).file
  if (!file || typeof file !== 'object') return false
  const f = file as {
    base64?: unknown
    content?: unknown
    cells?: unknown
    text?: unknown
  }
  if (typeof f.base64 === 'string' && f.base64.length > 0) return true
  if (typeof f.content === 'string' && f.content.length > 1) return true
  if (Array.isArray(f.cells) && f.cells.length > 0) return true
  if (typeof f.text === 'string' && f.text.length > 500) return true
  return false
}
