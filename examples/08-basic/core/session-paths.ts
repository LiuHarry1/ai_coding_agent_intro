/**
 * Shared session storage root (jsonl + per-session dirs).
 * Kept in core so services/ and server/ can both import without layering cycles.
 */
import * as path from 'path'

export const SESSION_DIR = path.resolve('.sessions')

export function getSessionJsonlPath(sessionId: string): string {
  return path.join(SESSION_DIR, `${sessionId}.jsonl`)
}

export function getSessionDataDir(sessionId: string): string {
  return path.join(SESSION_DIR, sessionId)
}
