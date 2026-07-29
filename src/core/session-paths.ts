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

export function getToolResultFilePath(
  sessionId: string,
  toolCallId: string,
): string {
  const safe = toolCallId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return path.join(SESSION_DIR, sessionId, 'tool-results', `${safe}.txt`)
}
