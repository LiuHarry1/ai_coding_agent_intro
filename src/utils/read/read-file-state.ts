/**
 * Session readFileState helpers — CC-style Read dedup + Edit/Write bookkeeping.
 *
 * Dedup only applies to entries with `offset !== undefined` (came from Read).
 * Edit/Write set offset/limit to undefined so they never false-stub against
 * pre-edit Read content.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import * as fs from 'fs'
import type { ReadFileState, ReadFileStateEntry } from './types.js'
import { FILE_UNCHANGED_STUB } from './boundary-reminders.js'

export { FILE_UNCHANGED_STUB }

/**
 * Fork-local map installed by `runForkedAgent`.
 *
 * Side-path forks (Auto Memory / Session Memory extract, full compact) reuse
 * the parent's bound tool instances, and a tool's `execute` closed over the
 * ToolContext it was created with — so its reads would otherwise land in the
 * main session map. Anything in that map is treated as already-in-context by
 * Auto Memory prefetch, which silently kills later recall.
 *
 * Routing every file tool through `activeReadFileState` gives a fork its own
 * clone without rebuilding the tool set, and leaves the session map untouched
 * even while the main loop runs concurrently (extracts are not awaited).
 */
const forkedReadFileState = new AsyncLocalStorage<ReadFileState>()

/** Run `fn` with file tools reading/writing `state` instead of the session map. */
export function runWithForkedReadFileState<T>(
  state: ReadFileState,
  fn: () => Promise<T>,
): Promise<T> {
  return forkedReadFileState.run(state, fn)
}

/** The fork-local map when inside a fork scope, else the session map. */
export function activeReadFileState(
  sessionState: ReadFileState | undefined,
): ReadFileState | undefined {
  return forkedReadFileState.getStore() ?? sessionState
}

/** Normalize Read offset for cache keys (1-based; undefined → 1). */
export function normalizeReadOffset(offset?: number): number {
  if (offset == null) return 1
  return offset
}

export function rangeEquals(
  entry: ReadFileStateEntry,
  offset: number | undefined,
  limit: number | undefined,
): boolean {
  if (entry.offset === undefined) return false
  return (
    entry.offset === normalizeReadOffset(offset) && entry.limit === limit
  )
}

/**
 * If same path+range was Read and mtime matches, return true (caller should stub).
 */
export function shouldDedupRead(
  readFileState: ReadFileState | undefined,
  absPath: string,
  offset: number | undefined,
  limit: number | undefined,
): boolean {
  if (!readFileState) return false
  const existing = readFileState.get(absPath)
  if (!existing || existing.offset === undefined) return false
  if (!rangeEquals(existing, offset, limit)) return false
  try {
    const mtimeMs = Math.floor(fs.statSync(absPath).mtimeMs)
    return mtimeMs === existing.timestamp
  } catch {
    return false
  }
}

/** Record a successful text Read (enables later dedup). */
export function recordReadInState(
  readFileState: ReadFileState | undefined,
  absPath: string,
  content: string,
  offset: number | undefined,
  limit: number | undefined,
  mtimeMs?: number,
): void {
  if (!readFileState) return
  let ts = mtimeMs
  if (ts === undefined) {
    try {
      ts = fs.statSync(absPath).mtimeMs
    } catch {
      return
    }
  }
  readFileState.set(absPath, {
    content,
    timestamp: Math.floor(ts),
    offset: normalizeReadOffset(offset),
    limit,
  })
}

/**
 * After Edit/Write: refresh mtime snapshot but clear offset/limit so Read
 * dedup will not point at pre-edit content.
 */
export function recordWriteInState(
  readFileState: ReadFileState | undefined,
  absPath: string,
  content = '',
): void {
  if (!readFileState) return
  try {
    const mtimeMs = Math.floor(fs.statSync(absPath).mtimeMs)
    readFileState.set(absPath, {
      content,
      timestamp: mtimeMs,
      // offset/limit intentionally omitted — not eligible for Read dedup
    })
  } catch {
    readFileState.delete(absPath)
  }
}

/** Drop cache entries for absolute paths (e.g. after microcompact cleared those Reads). */
export function invalidateReadPaths(
  readFileState: ReadFileState | undefined,
  absPaths: Iterable<string>,
): number {
  if (!readFileState) return 0
  let n = 0
  for (const p of absPaths) {
    if (readFileState.delete(p)) n++
  }
  return n
}

export function clearReadFileState(
  readFileState: ReadFileState | undefined,
): void {
  readFileState?.clear()
}
