/**
 * Micro-compaction: cheap, no-LLM pass that clears old tool payloads.
 *
 * For read-oriented tools (bash, grep, read_file, ...) clears the OUTPUT.
 * For write-oriented tools (write_file, edit_file, ...) clears the INPUT.
 * Tool blocks are preserved (only payloads replaced) so tool_call ↔
 * tool_result pairing stays intact.
 *
 * When Read results are cleared, matching entries are dropped from
 * `readFileState` so file_unchanged dedup cannot stub against cleared content.
 */
import * as path from 'path'
import type {
  AssistantMessage,
  Message,
  ToolMessage,
} from '../../core/types.js'
import { isRoleMessage } from '../../core/types.js'
import type { ReadFileState } from '../../utils/attachments/types.js'
import { invalidateReadPaths } from '../../utils/read/read-file-state.js'
import { resolveFileInCwd } from '../../utils/read/index.js'
import {
  BASH_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
  FILE_READ_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from '../../constants/tool_names.js'
import { estimateMessageTokens } from './tokens.js'
import {
  isPersistedReference,
  offloadReferenceForCompact,
} from '../tool-storage/index.js'

const MICRO_COMPACT_MARKER = '[Old tool result content cleared to save context]'

const MICRO_COMPACT_INPUT_MARKER = {
  _cleared: true,
  note: 'Old tool input cleared to save context',
}

const CLEARABLE_TOOL_RESULTS = new Set<string>([
  BASH_TOOL_NAME,
  'shell',
  POWERSHELL_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  FILE_READ_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
])

const CLEARABLE_TOOL_INPUTS = new Set<string>([
  WRITE_FILE_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
  'create_file',
  'apply_patch',
  'NotebookEdit',
])

const CLEARABLE_MIN_CHARS = 2_000

function estStr(s: string): number {
  return Math.ceil(s.length / 4)
}

const MARKER_INPUT_JSON = JSON.stringify(MICRO_COMPACT_INPUT_MARKER)
const MARKER_INPUT_COST = estStr(MARKER_INPUT_JSON)

export interface MicroCompactResult {
  messages: Message[]
  tokensFreed: number
  cleared: number
  /** Absolute paths whose Read results were cleared (for readFileState sync). */
  clearedReadAbsPaths: string[]
}

function collectReadAbsByToolCallId(
  messages: Message[],
  cwd?: string,
): Map<string, string> {
  const map = new Map<string, string>()
  for (const m of messages) {
    if (!isRoleMessage(m) || m.role !== 'assistant') continue
    for (const part of m.content) {
      if (part.type !== 'tool-call') continue
      if (part.toolName !== FILE_READ_TOOL_NAME) continue
      const fp = part.input?.file_path
      if (typeof fp !== 'string' || !fp) continue
      if (cwd) {
        const resolved = resolveFileInCwd(cwd, fp)
        if (!('error' in resolved)) {
          map.set(part.toolCallId, resolved.abs)
          continue
        }
      }
      map.set(part.toolCallId, path.isAbsolute(fp) ? fp : path.resolve(fp))
    }
  }
  return map
}

function absFromToolUseResult(tur: unknown, cwd?: string): string | undefined {
  if (!tur || typeof tur !== 'object') return undefined
  const file = (tur as { file?: { filePath?: string } }).file
  const fp = file?.filePath
  if (typeof fp !== 'string' || !fp) return undefined
  if (cwd) {
    const resolved = resolveFileInCwd(cwd, fp)
    if (!('error' in resolved)) return resolved.abs
  }
  return path.isAbsolute(fp) ? fp : path.resolve(fp)
}

export function microCompact(
  messages: Message[],
  keepRecent: number,
  sessionId?: string,
  opts?: { cwd?: string; readFileState?: ReadFileState },
): MicroCompactResult {
  const toolMsgIdx: number[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (isRoleMessage(m) && m.role === 'tool') toolMsgIdx.push(i)
  }
  if (toolMsgIdx.length <= Math.max(0, keepRecent)) {
    return { messages, tokensFreed: 0, cleared: 0, clearedReadAbsPaths: [] }
  }

  const clearUpToExclusive = toolMsgIdx[toolMsgIdx.length - keepRecent - 1] + 1
  const readAbsById = collectReadAbsByToolCallId(messages, opts?.cwd)
  const clearedReadAbsPaths = new Set<string>()

  let tokensFreed = 0
  let cleared = 0

  const out = messages.map((m, i) => {
    if (i >= clearUpToExclusive) return m
    if (!isRoleMessage(m)) return m
    if (m.role === 'tool')
      return clearToolResults(
        m,
        sessionId,
        () => cleared++,
        n => (tokensFreed += n),
        readAbsById,
        clearedReadAbsPaths,
        opts?.cwd,
      )
    if (m.role === 'assistant')
      return clearToolInputs(
        m,
        () => cleared++,
        n => (tokensFreed += n),
      )
    return m
  })

  if (clearedReadAbsPaths.size > 0) {
    invalidateReadPaths(opts?.readFileState, clearedReadAbsPaths)
  }

  return {
    messages: out,
    tokensFreed,
    cleared,
    clearedReadAbsPaths: [...clearedReadAbsPaths],
  }
}

/**
 * Re-estimate token count after micro-compaction. Avoids full
 * re-estimation if we know how many tokens were freed.
 */
export function estimateAfterMicroCompact(
  messages: Message[],
  priorTotal: number,
  freed: number,
): number {
  if (freed > 0) return priorTotal - freed
  let t = 0
  for (const m of messages) t += estimateMessageTokens(m)
  return t
}

// ── Internals ───────────────────────────────────────────

function clearToolResults(
  m: ToolMessage,
  sessionId: string | undefined,
  bumpCleared: () => void,
  addFreed: (n: number) => void,
  readAbsById: Map<string, string>,
  clearedReadAbsPaths: Set<string>,
  cwd?: string,
): ToolMessage {
  let touched = false
  const newContent = m.content.map(part => {
    const v = part.output?.value ?? ''
    const text = typeof v === 'string' ? v : JSON.stringify(v)
    const clearable =
      CLEARABLE_TOOL_RESULTS.has(part.toolName) ||
      text.length >= CLEARABLE_MIN_CHARS
    if (!clearable) return part
    if (text === MICRO_COMPACT_MARKER || isPersistedReference(text)) return part

    if (part.toolName === FILE_READ_TOOL_NAME) {
      const fromTur = absFromToolUseResult(part.toolUseResult, cwd)
      const fromCall = readAbsById.get(part.toolCallId)
      const abs = fromTur ?? fromCall
      if (abs) clearedReadAbsPaths.add(abs)
    }

    const replacement = offloadReferenceForCompact(
      sessionId,
      part.toolCallId,
      part.toolName,
      text,
      MICRO_COMPACT_MARKER,
    )
    addFreed(Math.max(0, estStr(text) - estStr(replacement)))
    bumpCleared()
    touched = true
    return { ...part, output: { type: 'text' as const, value: replacement } }
  })
  return touched ? ({ ...m, content: newContent } as ToolMessage) : m
}

function clearToolInputs(
  m: AssistantMessage,
  bumpCleared: () => void,
  addFreed: (n: number) => void,
): AssistantMessage {
  let touched = false
  const newContent = m.content.map(part => {
    if (part.type !== 'tool-call') return part
    if (!CLEARABLE_TOOL_INPUTS.has(part.toolName)) return part
    const argsJson = JSON.stringify(part.input ?? {})
    if (argsJson === MARKER_INPUT_JSON) return part
    addFreed(Math.max(0, estStr(argsJson) - MARKER_INPUT_COST))
    bumpCleared()
    touched = true
    return { ...part, input: { ...MICRO_COMPACT_INPUT_MARKER } }
  })
  return touched ? ({ ...m, content: newContent } as AssistantMessage) : m
}
