import * as fs from 'fs'
import { randomUUID } from 'crypto'
import type { Session, SessionInfo, Message } from '../core/types.js'
import { isAttachmentMessage, isRoleMessage } from '../core/types.js'
import { createDefaultPermissionMode } from '../core/permission-mode.js'
import { resetSessionMemoryState } from '../services/session-memory/state.js'
import {
  SESSION_DIR,
  getSessionDataDir,
  getSessionJsonlPath,
  getToolResultFilePath,
} from '../core/session-paths.js'
import { normalizeWorkspacePath } from '../core/workspace-path.js'
import {
  parseSessionJsonLine,
  reviveBuffersInMessages,
  sessionJsonReplacer,
  sessionJsonReviver,
  stringifySessionJsonLine,
} from './json-serialize.js'
import { projectMessageForDisk } from './persist-project.js'

const sessions = new Map<string, Session>()

export { SESSION_DIR, getToolResultFilePath }

function sessionPath(id: string): string {
  return getSessionJsonlPath(id)
}

// ── In-flight turn mutex ────────────────────────
//
// One running turn per session. Without this, a user resending a message
// while a slow step (e.g. a ~30s full compaction) is still running spawns a
// CONCURRENT turn over the same messages array: both turns compact the same
// oversized history, checkpoints race, and the transcript accumulates one
// compact boundary per resend. An interactive single-threaded REPL avoids this
// by queueing input; for an HTTP server the equivalent is rejecting concurrent
// turns on the same session.

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

export function createSession(ownerEmail?: string): Session {
  const id = randomUUID()
  const session: Session = {
    id,
    messages: [],
    createdAt: Date.now(),
    ownerEmail,
    readFileState: new Map(),
    permissionMode: createDefaultPermissionMode(),
    additionalWorkingDirectories: [],
    agentType: null,
    hasExitedPlanMode: false,
    needsPlanModeExitAttachment: false,
  }
  sessions.set(id, session)
  fs.mkdirSync(SESSION_DIR, { recursive: true })
  appendLine(id, {
    type: 'session_created',
    id,
    createdAt: session.createdAt,
    ownerEmail: ownerEmail ?? null,
    permissionMode: session.permissionMode,
    agentType: session.agentType,
  })
  return session
}

export function getSession(id: string): Session | null {
  if (sessions.has(id)) return sessions.get(id)!

  const filePath = sessionPath(id)
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

/** Bind a WorkspaceHandle to the session (persisted in jsonl). */
export function setSessionWorkspace(
  sessionId: string,
  workspace: import('../execution/types.js').WorkspaceHandle,
): void {
  const session = getSession(sessionId)
  if (!session) return
  session.workspace = {
    environmentId: workspace.environmentId,
    cwd: normalizeWorkspacePath(workspace.cwd),
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
  if (!fs.existsSync(SESSION_DIR)) return []
  return fs
    .readdirSync(SESSION_DIR)
    .filter((f: string) => f.endsWith('.jsonl'))
    .map((f: string) => {
      const id = f.replace('.jsonl', '')
      return getSession(id)
    })
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
  sessions.delete(id)
  const filePath = sessionPath(id)
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath)
  }
  const memoryDir = getSessionDataDir(id)
  if (fs.existsSync(memoryDir)) {
    fs.rmSync(memoryDir, { recursive: true, force: true })
  }
  resetSessionMemoryState(id)
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
  // Snapshot so later in-memory mutations (new assistant/tool msgs) don't
  // alter the on-disk checkpoint.
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
  fs.mkdirSync(SESSION_DIR, { recursive: true })
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
      session.createdAt = line.createdAt
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
      const w = line.workspace
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
      // Checkpoint: discard everything accumulated so far and adopt the
      // post-compaction snapshot. Subsequent `message` lines append normally.
      session.messages = Array.isArray(line.messages)
        ? reviveBuffersInMessages(line.messages as Message[])
        : []
    } else if (line.type === 'message') {
      const { type: _, timestamp: __, ...msg } = line
      session.messages.push(
        ...reviveBuffersInMessages([msg as Message]),
      )
    } else if (line.type === 'attachment') {
      const { timestamp: _, ...msg } = line
      session.messages.push(msg as Message)
    }
  }

  return session
}
