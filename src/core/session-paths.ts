/**
 * Shared session storage root (jsonl + per-session dirs).
 * Kept in core so services/ and server/ can both import without layering cycles.
 *
 * Task output files live under `.sessions/{id}/tasks/` (outside the user's
 * project cwd when the agent repo ≠ workspace). Claude Code puts the same
 * files under project temp and auto-allows Read via checkReadableInternalPath —
 * mirror that here with isReadableInternalPath.
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

/**
 * ≈ Claude Code `checkReadableInternalPath` for project temp / tool-results:
 * session-owned files under `.sessions/` may be Read even when outside cwd.
 */
export function isReadableInternalPath(absPath: string): boolean {
  const normalized = path.normalize(path.resolve(absPath))
  const root = SESSION_DIR.endsWith(path.sep)
    ? SESSION_DIR
    : SESSION_DIR + path.sep
  return normalized === SESSION_DIR || normalized.startsWith(root)
}
