import * as path from 'path'
import { getSessionDataDir } from '../../core/session-paths.js'

export function getSessionMemoryDir(sessionId: string): string {
  return path.join(getSessionDataDir(sessionId), 'session-memory')
}

export function getSessionMemoryPath(sessionId: string): string {
  return path.join(getSessionMemoryDir(sessionId), 'summary.md')
}
