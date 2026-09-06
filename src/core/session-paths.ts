/**
 * Session storage under `{agentHome}/.ai-agent/projects/<sanitized>/`
 * (Claude Code layout). Pure path builders + location cache.
 *
 * Callers must register a SessionLocation before using sessionId-based helpers.
 * Miss does NOT invent a location.
 */
import * as path from 'path'
import {
  getAppDirName,
  getProcessAppDir,
} from '../utils/app-dir.js'
import { findCanonicalGitRoot } from '../utils/git-root.js'
import { resolveAgentHome } from '../utils/request-scope.js'
import { sanitizePath } from '../utils/sanitize-path.js'
import { getDefaultWorkspace } from './workspace.js'
import { normalizeWorkspacePath } from './workspace-path.js'

export type SessionLocation = {
  projectKey: string
  agentHome: string
}

const locationCache = new Map<string, SessionLocation>()

export function registerSessionLocation(
  sessionId: string,
  loc: SessionLocation,
): void {
  locationCache.set(sessionId, {
    projectKey: loc.projectKey,
    agentHome: path.resolve(loc.agentHome),
  })
}

export function unregisterSessionLocation(sessionId: string): void {
  locationCache.delete(sessionId)
}

export function getCachedSessionLocation(
  sessionId: string,
): SessionLocation | undefined {
  return locationCache.get(sessionId)
}

export function clearSessionLocationCache(): void {
  locationCache.clear()
}

/** Re-export: cron / process data dir. */
export { getProcessAppDir }

/** `{agentHome}/.ai-agent/projects` */
export function getProjectsRoot(agentHome?: string): string {
  return path.join(resolveAgentHome(agentHome), getAppDirName(), 'projects')
}

/** `{agentHome}/.ai-agent/session-index.json` */
export function getSessionIndexPath(agentHome?: string): string {
  return path.join(
    resolveAgentHome(agentHome),
    getAppDirName(),
    'session-index.json',
  )
}

/** `{agentHome}/.ai-agent/projects/<projectKey>` */
export function getProjectSessionDir(
  projectKey: string,
  agentHome?: string,
): string {
  return path.join(getProjectsRoot(agentHome), projectKey)
}

/**
 * Project bucket key (shared with Auto Memory for local cwd).
 * Remote SSH: `environmentId:cwd` without host git canonicalization.
 */
export function computeProjectKey(
  workspace?: { environmentId: string; cwd: string } | null,
  fallbackCwd?: string,
): string {
  if (workspace?.environmentId && workspace.environmentId !== 'local') {
    const remoteCwd = normalizeWorkspacePath(workspace.cwd)
    return sanitizePath(`${workspace.environmentId}:${remoteCwd}`)
  }
  const cwd = workspace?.cwd
    ? normalizeWorkspacePath(workspace.cwd)
    : path.resolve(fallbackCwd ?? getDefaultWorkspace())
  const base = findCanonicalGitRoot(cwd) ?? cwd
  return sanitizePath(base)
}

/** Local auto-memory / session bucket from a cwd (no remote env). */
export function computeLocalProjectKey(cwd: string): string {
  const resolved = path.resolve(cwd)
  return sanitizePath(findCanonicalGitRoot(resolved) ?? resolved)
}

export function requireSessionLocation(sessionId: string): SessionLocation {
  const cached = locationCache.get(sessionId)
  if (cached) return cached
  throw new Error(
    `No session location registered for ${sessionId}; create/getSession first`,
  )
}

export function sessionJsonlPath(
  loc: SessionLocation,
  sessionId: string,
): string {
  return path.join(
    getProjectSessionDir(loc.projectKey, loc.agentHome),
    `${sessionId}.jsonl`,
  )
}

export function sessionDataDir(
  loc: SessionLocation,
  sessionId: string,
): string {
  return path.join(getProjectSessionDir(loc.projectKey, loc.agentHome), sessionId)
}

export function getSessionJsonlPath(
  sessionId: string,
  projectKey?: string,
  agentHome?: string,
): string {
  if (projectKey !== undefined && agentHome !== undefined) {
    return sessionJsonlPath({ projectKey, agentHome }, sessionId)
  }
  return sessionJsonlPath(requireSessionLocation(sessionId), sessionId)
}

export function getSessionDataDir(
  sessionId: string,
  projectKey?: string,
  agentHome?: string,
): string {
  if (projectKey !== undefined && agentHome !== undefined) {
    return sessionDataDir({ projectKey, agentHome }, sessionId)
  }
  return sessionDataDir(requireSessionLocation(sessionId), sessionId)
}

export function getToolResultFilePath(
  sessionId: string,
  toolCallId: string,
  projectKey?: string,
  agentHome?: string,
): string {
  const safe = toolCallId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return path.join(
    getSessionDataDir(sessionId, projectKey, agentHome),
    'tool-results',
    `${safe}.txt`,
  )
}

/** Scratch under user app dir when no session (e.g. WebFetch without session). */
export function getScratchDataDir(kind: string): string {
  const safe = kind.replace(/[^a-zA-Z0-9_-]/g, '_') || 'scratch'
  return path.join(resolveAgentHome(), getAppDirName(), 'scratch', safe)
}

function isUnderRoot(absPath: string, root: string): boolean {
  const normalized = path.normalize(path.resolve(absPath))
  const r = path.normalize(path.resolve(root))
  const prefix = r.endsWith(path.sep) ? r : r + path.sep
  return normalized === r || normalized.startsWith(prefix)
}

/**
 * Internal readable roots for the current agent home only
 * (projects + plans under that home). No substring matching across tenants.
 */
export function isReadableInternalPath(absPath: string): boolean {
  const normalized = path.normalize(path.resolve(absPath))
  try {
    const home = resolveAgentHome()
    const projects = getProjectsRoot(home)
    const plans = path.join(home, getAppDirName(), 'plans')
    const scratch = path.join(home, getAppDirName(), 'scratch')
    return (
      isUnderRoot(normalized, projects) ||
      isUnderRoot(normalized, plans) ||
      isUnderRoot(normalized, scratch)
    )
  } catch {
    return false
  }
}
