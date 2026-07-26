/**
 * Per-session auto-memory runtime state (cursor + throttle).
 */

export type AutoMemoryRuntimeState = {
  /** Last message uuid covered by extract or skip-because-wrote. */
  lastAutoMemoryMessageUuid?: string
  /** Eligible turn-ends since last extract attempt. */
  turnsSinceExtract: number
}

const bySession = new Map<string, AutoMemoryRuntimeState>()

function emptyState(): AutoMemoryRuntimeState {
  return { turnsSinceExtract: 0 }
}

export function getAutoMemoryState(sessionId: string): AutoMemoryRuntimeState {
  let s = bySession.get(sessionId)
  if (!s) {
    s = emptyState()
    bySession.set(sessionId, s)
  }
  return s
}

export function resetAutoMemoryState(sessionId: string): void {
  bySession.set(sessionId, emptyState())
}

/** Test helper. */
export function clearAllAutoMemoryState(): void {
  bySession.clear()
}
