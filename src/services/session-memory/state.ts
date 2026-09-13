import * as fs from 'node:fs'
import * as path from 'node:path'
import { getSessionMemoryDir, getSessionMemoryStatePath } from './paths.js'

export type SessionMemoryRuntimeState = {
  initialized: boolean
  tokensAtLastExtraction: number
  lastTriggerMessageId?: string
  lastSummarizedMessageId?: string
  extractionStartedAt?: number
  inFlight: boolean
  /**
   * Monotonic epoch. Bumped when an extract starts and when a wait abandons a
   * stale in-flight extract so the abandoned run's `finally` won't clear a
   * newer extract's inFlight flag.
   */
  extractionEpoch: number
  /** Bumped after a successful notes file update (compact race detection). */
  notesGeneration: number
}

const bySession = new Map<string, SessionMemoryRuntimeState>()

function emptyState(): SessionMemoryRuntimeState {
  return {
    initialized: false,
    tokensAtLastExtraction: 0,
    inFlight: false,
    extractionEpoch: 0,
    notesGeneration: 0,
  }
}

type PersistedSessionMemoryState = Pick<
  SessionMemoryRuntimeState,
  | 'initialized'
  | 'tokensAtLastExtraction'
  | 'lastTriggerMessageId'
  | 'lastSummarizedMessageId'
  | 'notesGeneration'
>

function loadPersistedState(sessionId: string): SessionMemoryRuntimeState {
  const state = emptyState()
  try {
    const parsed = JSON.parse(
      fs.readFileSync(getSessionMemoryStatePath(sessionId), 'utf-8'),
    ) as Partial<PersistedSessionMemoryState>
    if (typeof parsed.initialized === 'boolean') {
      state.initialized = parsed.initialized
    }
    if (
      typeof parsed.tokensAtLastExtraction === 'number' &&
      Number.isFinite(parsed.tokensAtLastExtraction) &&
      parsed.tokensAtLastExtraction >= 0
    ) {
      state.tokensAtLastExtraction = parsed.tokensAtLastExtraction
    }
    if (typeof parsed.lastTriggerMessageId === 'string') {
      state.lastTriggerMessageId = parsed.lastTriggerMessageId
    }
    if (typeof parsed.lastSummarizedMessageId === 'string') {
      state.lastSummarizedMessageId = parsed.lastSummarizedMessageId
    }
    if (
      typeof parsed.notesGeneration === 'number' &&
      Number.isInteger(parsed.notesGeneration) &&
      parsed.notesGeneration >= 0
    ) {
      state.notesGeneration = parsed.notesGeneration
    }
  } catch {
    // Missing/corrupt state falls back to safe empty runtime state.
  }
  return state
}

export function getSessionMemoryState(
  sessionId: string,
): SessionMemoryRuntimeState {
  let s = bySession.get(sessionId)
  if (!s) {
    s = loadPersistedState(sessionId)
    bySession.set(sessionId, s)
  }
  return s
}

export function resetSessionMemoryState(sessionId: string): void {
  bySession.delete(sessionId)
  try {
    fs.rmSync(getSessionMemoryStatePath(sessionId), { force: true })
  } catch {
    // Session may already have been deleted or never registered.
  }
}

export function persistSessionMemoryState(sessionId: string): void {
  const state = getSessionMemoryState(sessionId)
  const persisted: PersistedSessionMemoryState = {
    initialized: state.initialized,
    tokensAtLastExtraction: state.tokensAtLastExtraction,
    notesGeneration: state.notesGeneration,
    ...(state.lastTriggerMessageId
      ? { lastTriggerMessageId: state.lastTriggerMessageId }
      : {}),
    ...(state.lastSummarizedMessageId
      ? { lastSummarizedMessageId: state.lastSummarizedMessageId }
      : {}),
  }
  try {
    const dir = getSessionMemoryDir(sessionId)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const statePath = getSessionMemoryStatePath(sessionId)
    const tempPath = path.join(dir, `.state.${process.pid}.${Date.now()}.tmp`)
    fs.writeFileSync(tempPath, JSON.stringify(persisted) + '\n', {
      encoding: 'utf-8',
      mode: 0o600,
    })
    try {
      fs.renameSync(tempPath, statePath)
    } catch (err) {
      // Windows rename does not replace an existing destination.
      if (
        process.platform !== 'win32' ||
        !(
          err instanceof Error &&
          'code' in err &&
          (err.code === 'EEXIST' || err.code === 'EPERM')
        )
      ) {
        throw err
      }
      fs.rmSync(statePath, { force: true })
      fs.renameSync(tempPath, statePath)
    }
  } catch (err) {
    console.warn(
      `[session-memory] failed to persist state session=${sessionId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
}

/** Test/process-reload helper: evict memory without deleting persisted state. */
export function evictSessionMemoryState(sessionId: string): void {
  bySession.delete(sessionId)
}

export function clearLastSummarizedMessageId(sessionId: string): void {
  const s = getSessionMemoryState(sessionId)
  s.lastSummarizedMessageId = undefined
  persistSessionMemoryState(sessionId)
}

/** Begin an extract; returns epoch token for matching `endExtraction`. */
export function beginExtraction(sessionId: string): number {
  const s = getSessionMemoryState(sessionId)
  s.extractionEpoch += 1
  s.inFlight = true
  s.extractionStartedAt = Date.now()
  return s.extractionEpoch
}

/** End extract only if this run still owns the epoch. */
export function endExtraction(sessionId: string, epoch: number): void {
  const s = getSessionMemoryState(sessionId)
  if (s.extractionEpoch !== epoch) return
  s.inFlight = false
  s.extractionStartedAt = undefined
}

export function bumpNotesGeneration(sessionId: string): void {
  getSessionMemoryState(sessionId).notesGeneration += 1
  persistSessionMemoryState(sessionId)
}

const EXTRACTION_WAIT_TIMEOUT_MS = 15_000
const EXTRACTION_STALE_MS = 60_000

/** Tests shrink the wait so the timeout path runs without a 15s pause. */
function extractionWaitTimeoutMs(): number {
  const override = Number(process.env.SM_EXTRACT_WAIT_TIMEOUT_MS)
  return override > 0 ? override : EXTRACTION_WAIT_TIMEOUT_MS
}

export type WaitExtractionResult = {
  /** True when no extract is in flight, i.e. notes are the newest generation. */
  ready: boolean
  clearedStale: boolean
  timedOut: boolean
  notesGeneration: number
}

function abandonStaleExtraction(sessionId: string, reason: string): void {
  const s = getSessionMemoryState(sessionId)
  if (!s.inFlight) return
  console.warn(
    `[session-memory] abandoning in-flight extract (${reason}) session=${sessionId}`,
  )
  s.extractionEpoch += 1
  s.inFlight = false
  s.extractionStartedAt = undefined
}

/**
 * Wait for in-flight extraction (compact path).
 * - Stale (>60s): clear inFlight and return ready.
 * - Wait timeout while still in flight: return ready=false. Callers compact
 *   from the previous generation rather than skipping; see trySessionMemoryCompaction.
 */
export async function waitForSessionMemoryExtraction(
  sessionId: string,
): Promise<WaitExtractionResult> {
  const start = Date.now()
  while (true) {
    const s = getSessionMemoryState(sessionId)
    if (!s.inFlight || !s.extractionStartedAt) {
      return {
        ready: true,
        clearedStale: false,
        timedOut: false,
        notesGeneration: s.notesGeneration,
      }
    }
    if (Date.now() - s.extractionStartedAt > EXTRACTION_STALE_MS) {
      abandonStaleExtraction(sessionId, `stale>${EXTRACTION_STALE_MS}ms`)
      return {
        ready: true,
        clearedStale: true,
        timedOut: false,
        notesGeneration: getSessionMemoryState(sessionId).notesGeneration,
      }
    }
    if (Date.now() - start > extractionWaitTimeoutMs()) {
      // Still running but not stale — caller compacts from the previous generation.
      return {
        ready: false,
        clearedStale: false,
        timedOut: true,
        notesGeneration: s.notesGeneration,
      }
    }
    await new Promise(r => setTimeout(r, 200))
  }
}
