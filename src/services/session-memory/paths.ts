import * as path from 'path'
import { SESSION_DIR } from '../../core/session-paths.js'

export function getSessionMemoryDir(sessionId: string): string {
  return path.join(SESSION_DIR, sessionId, 'session-memory')
}

export function getSessionMemoryPath(sessionId: string): string {
  return path.join(getSessionMemoryDir(sessionId), 'summary.md')
}
