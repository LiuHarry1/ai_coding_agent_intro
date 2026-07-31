/**
 * Per-tool AbortController registry so the UI can stop a single subagent
 * without aborting the whole chat turn.
 */

const controllers = new Map<string, AbortController>()

function key(sessionId: string, toolUseId: string): string {
  return `${sessionId}:${toolUseId}`
}

/** Register (or replace) an abort controller for a tool invocation. */
export function registerToolAbort(
  sessionId: string,
  toolUseId: string,
): AbortSignal {
  const k = key(sessionId, toolUseId)
  const existing = controllers.get(k)
  if (existing) existing.abort()
  const ac = new AbortController()
  controllers.set(k, ac)
  return ac.signal
}

/** Abort a running tool. Returns false if nothing was registered. */
export function abortTool(sessionId: string, toolUseId: string): boolean {
  const ac = controllers.get(key(sessionId, toolUseId))
  if (!ac) return false
  ac.abort()
  return true
}

export function clearToolAbort(sessionId: string, toolUseId: string): void {
  controllers.delete(key(sessionId, toolUseId))
}

export function isToolAborted(sessionId: string, toolUseId: string): boolean {
  return controllers.get(key(sessionId, toolUseId))?.signal.aborted === true
}
