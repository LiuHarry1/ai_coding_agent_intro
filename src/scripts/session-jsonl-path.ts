/** Resolve session jsonl via index (no legacy `.sessions` fallback). */
import { getSessionJsonlPath } from '../core/session-paths.js'
import { findSessionLocation } from '../session/session-index.js'
import { registerSessionLocation } from '../core/session-paths.js'

export function resolveSessionJsonlPath(sessionId: string): string {
  const loc = findSessionLocation(sessionId)
  if (!loc) {
    throw new Error(`session transcript not found: ${sessionId}`)
  }
  registerSessionLocation(sessionId, loc)
  return getSessionJsonlPath(sessionId, loc.projectKey, loc.agentHome)
}
