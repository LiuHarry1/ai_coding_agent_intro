/**
 * Select relevant topic memory files for a user query (CC findRelevantMemories).
 */
import type { IProvider } from '../../core/llm/types.js'
import { FILE_READ_TOOL_NAME } from '../../constants/tool_names.js'
import { memoryHeader } from './memoryAge.js'
import {
  formatMemoryManifest,
  readFileCapped,
  scanMemoryFiles,
  type MemoryFileMeta,
} from './scan.js'
import { sideQueryJson } from './sideQuery.js'

export type RelevantMemory = {
  path: string
  mtimeMs: number
}

export type SurfacedMemory = {
  path: string
  content: string
  mtimeMs: number
  header: string
  limit?: number
}

export const MAX_MEMORY_LINES = 200
export const MAX_MEMORY_BYTES = 4096
export const MAX_SESSION_BYTES = 60 * 1024

const SELECT_MEMORIES_SYSTEM_PROMPT = `You are selecting memories that will be useful to the coding agent as it processes a user's query. You will be given the user's query and a list of available memory files with their filenames and descriptions.

Return a list of filenames for the memories that will clearly be useful as the agent processes the user's query (up to 5). Only include memories that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful in processing the user's query, then do not include it in your list. Be selective and discerning.
- If there are no memories in the list that would clearly be useful, feel free to return an empty list.
- If a list of recently-used tools is provided, do not select memories that are usage reference or API documentation for those tools (the agent is already exercising them). DO still select memories containing warnings, gotchas, or known issues about those tools — active use is exactly when those matter.

Respond with a single JSON object only — no prose, no markdown fences.
Format: {"selected_memories":["file.md",...]}`

export type SelectRelevantFn = (
  query: string,
  memories: MemoryFileMeta[],
  recentTools: readonly string[],
  signal?: AbortSignal,
) => Promise<string[]>

export type FindRelevantOpts = {
  provider: IProvider
  modelId: string
  signal?: AbortSignal
  /** Injected selector for tests. */
  selectFn?: SelectRelevantFn
}

/**
 * Find up to 5 relevant topic files. Excludes MEMORY.md (via scan).
 * `alreadySurfaced` filters before the selector call.
 */
export async function findRelevantMemories(
  query: string,
  memoryDir: string,
  opts: FindRelevantOpts,
  recentTools: readonly string[] = [],
  alreadySurfaced: ReadonlySet<string> = new Set(),
): Promise<RelevantMemory[]> {
  const memories = scanMemoryFiles(memoryDir).filter(
    m => !alreadySurfaced.has(m.filePath),
  )
  if (memories.length === 0) return []

  const select =
    opts.selectFn ??
    createSelectRelevantMemories({
      provider: opts.provider,
      modelId: opts.modelId,
    })
  const selectedFilenames = await select(
    query,
    memories,
    recentTools,
    opts.signal,
  )
  const byFilename = new Map(memories.map(m => [m.filename, m]))
  return selectedFilenames
    .map(filename => byFilename.get(filename))
    .filter((m): m is MemoryFileMeta => m !== undefined)
    .map(m => ({ path: m.filePath, mtimeMs: m.mtimeMs }))
}

export function createSelectRelevantMemories(opts: {
  provider: IProvider
  modelId: string
}): SelectRelevantFn {
  return async (query, memories, recentTools, signal) => {
    const validFilenames = new Set(memories.map(m => m.filename))
    const manifest = formatMemoryManifest(memories)
    const toolsSection =
      recentTools.length > 0
        ? `\n\nRecently used tools: ${recentTools.join(', ')}`
        : ''
    const parsed = await sideQueryJson<{ selected_memories?: string[] }>({
      provider: opts.provider,
      modelId: opts.modelId,
      system: SELECT_MEMORIES_SYSTEM_PROMPT,
      user: `Query: ${query}\n\nAvailable memories:\n${manifest}${toolsSection}`,
      maxOutputTokens: 256,
      signal,
    })
    if (!parsed?.selected_memories || !Array.isArray(parsed.selected_memories)) {
      return []
    }
    return parsed.selected_memories.filter(
      (f): f is string => typeof f === 'string' && validFilenames.has(f),
    )
  }
}

export async function readMemoriesForSurfacing(
  selected: ReadonlyArray<{ path: string; mtimeMs: number }>,
  signal?: AbortSignal,
): Promise<SurfacedMemory[]> {
  const results = await Promise.all(
    selected.map(async ({ path: filePath, mtimeMs }) => {
      if (signal?.aborted) return null
      try {
        const result = readFileCapped(
          filePath,
          MAX_MEMORY_LINES,
          MAX_MEMORY_BYTES,
        )
        const truncated =
          result.truncatedByLines ||
          result.truncatedByBytes ||
          result.totalLines > MAX_MEMORY_LINES
        const content = truncated
          ? result.content +
            `\n\n> This memory file was truncated (${result.truncatedByBytes ? `${MAX_MEMORY_BYTES} byte limit` : `first ${MAX_MEMORY_LINES} lines`}). Use the ${FILE_READ_TOOL_NAME} tool to view the complete file at: ${filePath}`
          : result.content
        return {
          path: filePath,
          content,
          mtimeMs: result.mtimeMs || mtimeMs,
          header: memoryHeader(filePath, result.mtimeMs || mtimeMs),
          limit: truncated ? result.lineCount : undefined,
        }
      } catch {
        return null
      }
    }),
  )
  return results.filter((r): r is SurfacedMemory => r !== null)
}
