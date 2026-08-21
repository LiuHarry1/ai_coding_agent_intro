/**
 * Per-session turn AbortController — Stop / disconnect / ACP cancel all
 * call abortTurn(sessionId, reason) instead of inventing parallel cleanup.
 */
import { createAbortController } from '../utils/abortController.js'
import { abortAllToolsForSession } from './tool-abort-registry.js'

export type TurnAbortReason =
  | 'user-cancel'
  | 'interrupt'
  | 'disconnect'
  | 'external'

interface TurnEntry {
  controller: AbortController
}

const turns = new Map<string, TurnEntry>()

export function isTurnAbortReason(value: unknown): value is TurnAbortReason {
  return (
    value === 'user-cancel' ||
    value === 'interrupt' ||
    value === 'disconnect' ||
    value === 'external'
  )
}

export function abortReasonFromSignal(
  signal?: AbortSignal | null,
): TurnAbortReason | undefined {
  if (!signal?.aborted) return undefined
  return isTurnAbortReason(signal.reason) ? signal.reason : 'user-cancel'
}

/** Register (replace) the abort controller for this session's active turn. */
export function registerTurnAbort(
  sessionId: string,
  controller?: AbortController,
): AbortController {
  const prev = turns.get(sessionId)
  if (prev && prev.controller !== controller) {
    prev.controller.abort('external')
  }
  const ac = controller ?? createAbortController()
  turns.set(sessionId, { controller: ac })
  return ac
}

/**
 * Abort the active turn. Returns false if nothing was registered.
 * Also aborts every registered in-flight tool for the session.
 */
export function abortTurn(
  sessionId: string,
  reason: TurnAbortReason = 'user-cancel',
): boolean {
  const entry = turns.get(sessionId)
  if (!entry) return false
  if (!entry.controller.signal.aborted) {
    entry.controller.abort(reason)
  }
  abortAllToolsForSession(sessionId)
  return true
}

export function clearTurnAbort(
  sessionId: string,
  controller?: AbortController,
): void {
  const cur = turns.get(sessionId)
  if (!cur) return
  if (controller && cur.controller !== controller) return
  turns.delete(sessionId)
}

export function getTurnAbortController(
  sessionId: string,
): AbortController | undefined {
  return turns.get(sessionId)?.controller
}

export function isTurnAborted(sessionId: string): boolean {
  return turns.get(sessionId)?.controller.signal.aborted === true
}
