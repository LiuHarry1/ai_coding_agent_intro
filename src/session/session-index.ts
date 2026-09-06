/**
 * Per-agentHome session index: id → { projectKey, createdAt, ownerEmail? }
 * Lives at `{agentHome}/.ai-agent/session-index.json`.
 */
import * as fs from 'fs'
import * as path from 'path'
import {
  getSessionIndexPath,
  type SessionLocation,
} from '../core/session-paths.js'
import { getAppDirName } from '../utils/app-dir.js'
import { resolveAgentHome } from '../utils/request-scope.js'

export type SessionIndexEntry = {
  projectKey: string
  createdAt: number
  ownerEmail?: string
}

export type SessionIndexFile = {
  version: 1
  sessions: Record<string, SessionIndexEntry>
}

function emptyIndex(): SessionIndexFile {
  return { version: 1, sessions: {} }
}

export function readSessionIndex(agentHome?: string): SessionIndexFile {
  const filePath = getSessionIndexPath(resolveAgentHome(agentHome))
  if (!fs.existsSync(filePath)) return emptyIndex()
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as SessionIndexFile
    if (!raw || raw.version !== 1 || typeof raw.sessions !== 'object') {
      return emptyIndex()
    }
    return raw
  } catch {
    return emptyIndex()
  }
}

export function writeSessionIndex(
  index: SessionIndexFile,
  agentHome?: string,
): void {
  const home = resolveAgentHome(agentHome)
  const filePath = getSessionIndexPath(home)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  const body = JSON.stringify(index, null, 2) + '\n'
  fs.writeFileSync(tmp, body, 'utf-8')
  fs.renameSync(tmp, filePath)
}

export function upsertSessionIndexEntry(
  sessionId: string,
  entry: SessionIndexEntry,
  agentHome?: string,
): void {
  const home = resolveAgentHome(agentHome)
  const index = readSessionIndex(home)
  index.sessions[sessionId] = entry
  writeSessionIndex(index, home)
}

export function removeSessionIndexEntry(
  sessionId: string,
  agentHome?: string,
): void {
  const home = resolveAgentHome(agentHome)
  const index = readSessionIndex(home)
  if (!(sessionId in index.sessions)) return
  delete index.sessions[sessionId]
  writeSessionIndex(index, home)
}

export function lookupSessionIndexEntry(
  sessionId: string,
  agentHome?: string,
): SessionIndexEntry | null {
  const entry = readSessionIndex(agentHome).sessions[sessionId]
  return entry ?? null
}

export function entryToLocation(
  entry: SessionIndexEntry,
  agentHome: string,
): SessionLocation {
  return { projectKey: entry.projectKey, agentHome: path.resolve(agentHome) }
}

/**
 * List agent homes that may hold session indexes.
 * AUTH off: current/os home. AUTH on: USERS_ROOT/* (and current ALS home).
 */
export function listSessionAgentHomes(): string[] {
  const homes = new Set<string>()
  homes.add(resolveAgentHome())

  const authOn =
    String(process.env.AUTH_ENABLED ?? '')
      .trim()
      .toLowerCase() === 'true'
  if (authOn) {
    const usersRoot = process.env.USERS_ROOT?.trim()
    if (usersRoot) {
      const root = path.resolve(usersRoot)
      try {
        for (const name of fs.readdirSync(root)) {
          const dir = path.join(root, name)
          try {
            if (!fs.statSync(dir).isDirectory()) continue
          } catch {
            continue
          }
          const idx = path.join(dir, getAppDirName(), 'session-index.json')
          if (fs.existsSync(idx)) homes.add(dir)
          else {
            const projects = path.join(dir, getAppDirName(), 'projects')
            if (fs.existsSync(projects)) homes.add(dir)
          }
        }
      } catch {
        // ignore
      }
    }
  }

  return [...homes]
}

/** Find session id across known agent homes. */
export function findSessionLocation(
  sessionId: string,
  preferredHome?: string,
): SessionLocation | null {
  if (preferredHome) {
    const entry = lookupSessionIndexEntry(sessionId, preferredHome)
    if (entry) return entryToLocation(entry, preferredHome)
  }
  const current = resolveAgentHome()
  const entry = lookupSessionIndexEntry(sessionId, current)
  if (entry) return entryToLocation(entry, current)

  for (const home of listSessionAgentHomes()) {
    if (path.resolve(home) === path.resolve(current)) continue
    if (
      preferredHome &&
      path.resolve(home) === path.resolve(preferredHome)
    ) {
      continue
    }
    const e = lookupSessionIndexEntry(sessionId, home)
    if (e) return entryToLocation(e, home)
  }
  return null
}
