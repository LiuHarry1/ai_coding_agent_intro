import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import type { Session, SessionInfo, Message } from '../core/types.js'
import { isAttachmentMessage, isRoleMessage } from '../core/types.js'
import { createDefaultPermissionMode } from '../core/permission-mode.js'
import { resetSessionMemoryState } from '../services/session-memory/state.js'
import { removeTasksForSession } from '../services/cron/store.js'
import {
  computeProjectKey,
  getCachedSessionLocation,
  getProjectSessionDir,
  getSessionDataDir,
  getSessionJsonlPath,
  getToolResultFilePath,
  registerSessionLocation,
  unregisterSessionLocation,
  type SessionLocation,
} from '../core/session-paths.js'
import { getDefaultWorkspace } from '../core/workspace.js'
import { normalizeWorkspacePath } from '../core/workspace-path.js'
import { resolveAgentHome } from '../utils/request-scope.js'
import {
  findSessionLocation,
  listSessionAgentHomes,
  readSessionIndex,
  removeSessionIndexEntry,
  upsertSessionIndexEntry,
} from './session-index.js'
import {
  parseSessionJsonLine,
  reviveBuffersInMessages,
  sessionJsonReplacer,
  sessionJsonReviver,
  stringifySessionJsonLine,
} from './json-serialize.js'
import { projectMessageForDisk } from './persist-project.js'

const sessions = new Map<string, Session>()

export { getToolResultFilePath }

/** Resolve location from cache or index; never invent. */
function locationFor(sessionId: string): SessionLocation {
  const cached = getCachedSessionLocation(sessionId)
  if (cached) return cached
  const found = findSessionLocation(sessionId)
  if (found) {
    registerSessionLocation(sessionId, found)
    return found
  }
  throw new Error(
    `No session location for ${sessionId}; create/getSession first`,
  )
}

function sessionPath(id: string): string {
  const loc = locationFor(id)
  return getSessionJsonlPath(id, loc.projectKey, loc.agentHome)
}

function ensureProjectDir(loc: SessionLocation): void {
  fs.mkdirSync(getProjectSessionDir(loc.projectKey, loc.agentHome), {
    recursive: true,
  })
}

// ── In-flight turn mutex ────────────────────────

const activeTurns = new Set<string>()

/** Returns false when a turn is already running for this session. */
export function tryBeginTurn(sessionId: string): boolean {
  if (activeTurns.has(sessionId)) return false
  activeTurns.add(sessionId)
  return true
}

export function endTurn(sessionId: string): void {
  activeTurns.delete(sessionId)
}

export type CreateSessionOptions = {
  ownerEmail?: string
  /** Override agent home (cron / tests). Default: getAgentHome(). */
  agentHome?: string
  /** Initial project key cwd (before workspace_bound). */
  cwd?: string
}

export function createSession(
  ownerEmailOrOpts?: string | CreateSessionOptions,
): Session {
  const opts: CreateSessionOptions =
    typeof ownerEmailOrOpts === 'string' || ownerEmailOrOpts === undefined
      ? { ownerEmail: ownerEmailOrOpts }
      : ownerEmailOrOpts

  const id = randomUUID()
  const agentHome = resolveAgentHome(opts.agentHome)
  const projectKey = computeProjectKey(undefined, opts.cwd ?? getDefaultWorkspace())
  const loc: SessionLocation = { projectKey, agentHome }
  registerSessionLocation(id, loc)

  const session: Session = {
    id,
    messages: [],
    createdAt: Date.now(),
    ownerEmail: opts.ownerEmail,
    readFileState: new Map(),
    permissionMode: createDefaultPermissionMode(),
    additionalWorkingDirectories: [],
    agentType: null,
    hasExitedPlanMode: false,
    needsPlanModeExitAttachment: false,
  }
  sessions.set(id, session)
  ensureProjectDir(loc)
  upsertSessionIndexEntry(
    id,
    {
      projectKey,
      createdAt: session.createdAt,
      ownerEmail: opts.ownerEmail,
    },
    agentHome,
  )
  appendLine(id, {
    type: 'session_created',
    id,
    createdAt: session.createdAt,
    ownerEmail: opts.ownerEmail ?? null,
    permissionMode: session.permissionMode,
    agentType: session.agentType,
  })
  return session
}

export type GetSessionOptions = {
  agentHome?: string
}

export function getSession(
  id: string,
  opts?: GetSessionOptions,
): Session | null {
  if (sessions.has(id)) return sessions.get(id)!

  const found = findSessionLocation(id, opts?.agentHome)
  if (!found) return null
  registerSessionLocation(id, found)

  const filePath = getSessionJsonlPath(id, found.projectKey, found.agentHome)
  if (!fs.existsSync(filePath)) return null

  const session = restoreFromDisk(id)
  sessions.set(id, session)
  return session
}

function extractPreview(session: Session | null): string | undefined {
  if (!session) return undefined
  if (session.title?.trim()) return session.title.trim()
  const firstUser = session.messages.find(
    m => isRoleMessage(m) && m.role === 'user',
  )
  if (!firstUser) return undefined
  const text =
    typeof firstUser.content === 'string'
      ? firstUser.content
      : (firstUser.content as Array<{ type: string; text?: string }>)
          .filter(p => p.type === 'text')
          .map(p => p.text)
          .join('')
  return text.slice(0, 80) || undefined
}

/** Persist an LLM-generated session title (append-only jsonl + in-memory). */
export function setSessionTitle(sessionId: string, title: string): void {
  const session = getSession(sessionId)
  if (!session) return
  const cleaned = title.trim()
  if (!cleaned) return
  session.title = cleaned
  appendLine(sessionId, {
    type: 'session_title',
    title: cleaned,
    timestamp: Date.now(),
  })
}

function relocateSessionFiles(
  sessionId: string,
  from: SessionLocation,
  to: SessionLocation,
): void {
  if (
    from.projectKey === to.projectKey &&
    path.resolve(from.agentHome) === path.resolve(to.agentHome)
  ) {
    return
  }
  ensureProjectDir(to)
  const oldJsonl = getSessionJsonlPath(sessionId, from.projectKey, from.agentHome)
  const newJsonl = getSessionJsonlPath(sessionId, to.projectKey, to.agentHome)
  const oldData = getSessionDataDir(sessionId, from.projectKey, from.agentHome)
  const newData = getSessionDataDir(sessionId, to.projectKey, to.agentHome)

  if (fs.existsSync(oldJsonl)) {
    fs.renameSync(oldJsonl, newJsonl)
  }
  if (fs.existsSync(oldData)) {
    fs.renameSync(oldData, newData)
  }

  if (path.resolve(from.agentHome) !== path.resolve(to.agentHome)) {
    removeSessionIndexEntry(sessionId, from.agentHome)
  }
  registerSessionLocation(sessionId, to)
}

/** Bind a WorkspaceHandle to the session (persisted in jsonl). */
export function setSessionWorkspace(
  sessionId: string,
  workspace: import('../execution/types.js').WorkspaceHandle,
): void {
  const session = getSession(sessionId)
  if (!session) return

  const bound = {
    environmentId: workspace.environmentId,
    cwd: normalizeWorkspacePath(workspace.cwd),
  }
  session.workspace = bound

  const from = locationFor(sessionId)
  const newKey = computeProjectKey(bound)
  const to: SessionLocation = {
    projectKey: newKey,
    agentHome: from.agentHome,
  }
  if (from.projectKey !== to.projectKey) {
    relocateSessionFiles(sessionId, from, to)
    upsertSessionIndexEntry(
      sessionId,
      {
        projectKey: to.projectKey,
        createdAt: session.createdAt,
        ownerEmail: session.ownerEmail,
      },
      to.agentHome,
    )
  }

  appendLine(sessionId, {
    type: 'workspace_bound',
    workspace: session.workspace,
    timestamp: Date.now(),
  })
}

/**
 * List sessions. In SSO mode pass the requester's email to return only that
 * user's sessions; omit it (or run without auth) to list everything.
 */
export function listSessions(ownerEmail?: string): SessionInfo[] {
  const homes = listSessionAgentHomes()

  const ids = new Set<string>()
  for (const home of homes) {
    const index = readSessionIndex(home)
    for (const [id, entry] of Object.entries(index.sessions)) {
      if (ownerEmail !== undefined && entry.ownerEmail !== ownerEmail) continue
      ids.add(id)
      registerSessionLocation(id, {
        projectKey: entry.projectKey,
        agentHome: home,
      })
    }
  }

  return [...ids]
    .map(id => getSession(id))
    .filter((session: Session | null): session is Session => {
      if (!session) return false
      if (ownerEmail === undefined) return true
      return session.ownerEmail === ownerEmail
    })
    .map((session: Session) => ({
      id: session.id,
      createdAt: session.createdAt,
      messageCount: session.messages.length,
      preview: extractPreview(session),
      permissionMode: session.permissionMode.mode,
      agentType: session.agentType ?? null,
      ownerEmail: session.ownerEmail,
    }))
    .sort(
      (a: SessionInfo, b: SessionInfo) =>
        (b.createdAt ?? 0) - (a.createdAt ?? 0),
    )
}

export function deleteSession(id: string): void {
  const loc = getCachedSessionLocation(id) ?? findSessionLocation(id)
  sessions.delete(id)

  if (loc) {
    const filePath = getSessionJsonlPath(id, loc.projectKey, loc.agentHome)
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    const memoryDir = getSessionDataDir(id, loc.projectKey, loc.agentHome)
    if (fs.existsSync(memoryDir)) {
      fs.rmSync(memoryDir, { recursive: true, force: true })
    }
    removeSessionIndexEntry(id, loc.agentHome)
  }
  unregisterSessionLocation(id)
  resetSessionMemoryState(id)
  try {
    removeTasksForSession(id)
  } catch (err) {
    console.warn(
      `[session] failed to drop scheduled tasks for ${id}: ${err instanceof Error ? err.message : err}`,
    )
  }
}

export function appendMessage(sessionId: string, message: Message): void {
  const timestamp = Date.now()
  if (isAttachmentMessage(message)) {
    appendLine(sessionId, { ...message, timestamp })
    return
  }
  const forDisk = projectMessageForDisk(message)
  appendLine(sessionId, { type: 'message', ...forDisk, timestamp })
}

/**
 * Record a compaction in the append-only log. Compaction REPLACES the whole
 * message list (with a summary + restored context), so a plain append would
 * leave the pre-compaction messages in the log and resurrect them on restore.
 * We write a `compacted` checkpoint; restoreFromDisk resets the in-memory
 * messages to this snapshot when it replays the line.
 */
export function appendCompaction(sessionId: string, messages: Message[]): void {
  const snapshot = JSON.parse(
    JSON.stringify(messages, sessionJsonReplacer),
    sessionJsonReviver,
  ) as Message[]
  appendLine(sessionId, {
    type: 'compacted',
    messages: snapshot,
    timestamp: Date.now(),
  })
}

export function appendModeChange(sessionId: string, session: Session): void {
  appendLine(sessionId, {
    type: 'mode_changed',
    permissionMode: session.permissionMode,
    agentType: session.agentType ?? null,
    hasExitedPlanMode: session.hasExitedPlanMode ?? false,
    needsPlanModeExitAttachment: session.needsPlanModeExitAttachment ?? false,
    timestamp: Date.now(),
  })
}

/** Persist main-thread agent profile changes. */
export function appendAgentChange(sessionId: string, session: Session): void {
  appendLine(sessionId, {
    type: 'agent_changed',
    agentType: session.agentType ?? null,
    permissionMode: session.permissionMode,
    timestamp: Date.now(),
  })
}

function appendLine(sessionId: string, data: Record<string, unknown>): void {
  const loc = locationFor(sessionId)
  ensureProjectDir(loc)
  fs.appendFileSync(sessionPath(sessionId), stringifySessionJsonLine(data) + '\n')
}

function restoreFromDisk(id: string): Session {
  const raw = fs.readFileSync(sessionPath(id), 'utf-8').trim()
  const lines = raw.split('\n').map((l: string) => parseSessionJsonLine(l))

  const session: Session = {
    id,
    messages: [],
    createdAt: Date.now(),
    readFileState: new Map(),
    permissionMode: createDefaultPermissionMode(),
    additionalWorkingDirectories: [],
    agentType: null,
    hasExitedPlanMode: false,
    needsPlanModeExitAttachment: false,
  }

  for (const line of lines) {
    if (line.type === 'session_created') {
      if (typeof line.createdAt === 'number') {
        session.createdAt = line.createdAt
      }
      if (typeof line.ownerEmail === 'string') {
        session.ownerEmail = line.ownerEmail
      }
      if (line.permissionMode) {
        session.permissionMode =
          line.permissionMode as Session['permissionMode']
      }
      if (line.agentType === null || typeof line.agentType === 'string') {
        session.agentType = line.agentType
      }
    } else if (line.type === 'mode_changed') {
      if (line.permissionMode) {
        session.permissionMode =
          line.permissionMode as Session['permissionMode']
      }
      if (line.agentType === null || typeof line.agentType === 'string') {
        session.agentType = line.agentType
      }
      if (typeof line.hasExitedPlanMode === 'boolean') {
        session.hasExitedPlanMode = line.hasExitedPlanMode
      }
      if (typeof line.needsPlanModeExitAttachment === 'boolean') {
        session.needsPlanModeExitAttachment = line.needsPlanModeExitAttachment
      }
    } else if (line.type === 'agent_changed') {
      if (line.agentType === null || typeof line.agentType === 'string') {
        session.agentType = line.agentType
      }
      if (line.permissionMode) {
        session.permissionMode =
          line.permissionMode as Session['permissionMode']
      }
    } else if (line.type === 'session_title') {
      if (typeof line.title === 'string' && line.title.trim()) {
        session.title = line.title.trim()
      }
    } else if (line.type === 'workspace_bound') {
      const w = line.workspace as
        | { environmentId?: unknown; cwd?: unknown }
        | undefined
      if (
        w &&
        typeof w.environmentId === 'string' &&
        typeof w.cwd === 'string'
      ) {
        session.workspace = {
          environmentId: w.environmentId,
          cwd: w.cwd,
        }
      }
    } else if (line.type === 'compacted') {
      session.messages = Array.isArray(line.messages)
        ? reviveBuffersInMessages(line.messages as Message[])
        : []
    } else if (line.type === 'message') {
      const { type: _, timestamp: __, ...msg } = line
      session.messages.push(
        ...reviveBuffersInMessages([msg as unknown as Message]),
      )
    } else if (line.type === 'attachment') {
      const { timestamp: _, ...msg } = line
      session.messages.push(msg as unknown as Message)
    }
  }

  return session
}

/** Absolute jsonl path for UI / tests (resolves via index). */
export function getSessionTranscriptPath(sessionId: string): string | null {
  const loc = getCachedSessionLocation(sessionId) ?? findSessionLocation(sessionId)
  if (!loc) return null
  registerSessionLocation(sessionId, loc)
  return getSessionJsonlPath(sessionId, loc.projectKey, loc.agentHome)
}

export function getSessionDataDirFor(sessionId: string): string {
  return getSessionDataDir(sessionId)
}
