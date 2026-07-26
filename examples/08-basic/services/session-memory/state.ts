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

export function getSessionMemoryState(
  sessionId: string,
): SessionMemoryRuntimeState {
  let s = bySession.get(sessionId)
  if (!s) {
    s = emptyState()
    bySession.set(sessionId, s)
  }
  return s
}

export function resetSessionMemoryState(sessionId: string): void {
  bySession.set(sessionId, emptyState())
}

export function clearLastSummarizedMessageId(sessionId: string): void {
  const s = getSessionMemoryState(sessionId)
  s.lastSummarizedMessageId = undefined
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
}

const EXTRACTION_WAIT_TIMEOUT_MS = 15_000
const EXTRACTION_STALE_MS = 60_000

export type WaitExtractionResult = {
  /** True when no extract is in flight (safe to read notes for SM compact). */
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
 * - Wait timeout while still in flight: return ready=false (caller skips SM).
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
    if (Date.now() - start > EXTRACTION_WAIT_TIMEOUT_MS) {
      // Still running but not stale — do not compact from possibly mid-write notes.
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
