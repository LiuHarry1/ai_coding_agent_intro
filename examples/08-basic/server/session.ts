import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import type { Session, SessionInfo, Message } from "../core/types.js";
import { createDefaultPermissionMode } from "../core/permission-mode.js";
import type { ExternalMode } from "../core/permission-mode.js";
import { isAuthEnabled, isSuperRole } from "./auth/identity.js";

const SESSION_DIR = path.resolve(".sessions");
const sessions = new Map<string, Session>();

export { SESSION_DIR };

export function getToolResultFilePath(sessionId: string, toolCallId: string): string {
  const safe = toolCallId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(SESSION_DIR, sessionId, "tool-results", `${safe}.txt`);
}

function sessionPath(id: string): string {
  return path.join(SESSION_DIR, `${id}.jsonl`);
}

export function createSession(ownerEmail?: string): Session {
  const id = randomUUID();
  const session: Session = {
    id,
    messages: [],
    createdAt: Date.now(),
    ownerEmail,
    readFileState: new Map(),
    permissionMode: createDefaultPermissionMode(),
    hasExitedPlanMode: false,
    needsPlanModeExitAttachment: false,
  };
  sessions.set(id, session);
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  appendLine(id, {
    type: "session_created",
    id,
    createdAt: session.createdAt,
    ownerEmail: ownerEmail ?? null,
    permissionMode: session.permissionMode,
  });
  return session;
}

/**
 * Whether `requesterEmail` may read/modify `session`.
 *
 * - Auth off (legacy / local / password mode): always true.
 * - Auth on: the requester must match the session's recorded owner, unless
 *   their JWT role is `super` (may read any session). Sessions with no owner
 *   are denied to non-super users so UUID guessing cannot leak history.
 */
export function canAccessSession(
  session: Session,
  requesterEmail: string | undefined,
  requesterRole?: string,
): boolean {
  if (!isAuthEnabled()) return true;
  if (isSuperRole(requesterRole)) return true;
  return Boolean(requesterEmail) && session.ownerEmail === requesterEmail;
}

export function getSession(id: string): Session | null {
  if (sessions.has(id)) return sessions.get(id)!;

  const filePath = sessionPath(id);
  if (!fs.existsSync(filePath)) return null;

  const session = restoreFromDisk(id);
  sessions.set(id, session);
  return session;
}

function extractPreview(session: Session | null): string | undefined {
  if (!session) return undefined;
  const firstUser = session.messages.find((m) => m.role === "user");
  if (!firstUser) return undefined;
  const text =
    typeof firstUser.content === "string"
      ? firstUser.content
      : (firstUser.content as Array<{ type: string; text?: string }>)
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("");
  return text.slice(0, 80) || undefined;
}

/**
 * List sessions. In SSO mode pass the requester's email to return only that
 * user's sessions; omit it (or run without auth) to list everything.
 */
export function listSessions(ownerEmail?: string): SessionInfo[] {
  if (!fs.existsSync(SESSION_DIR)) return [];
  return fs
    .readdirSync(SESSION_DIR)
    .filter((f: string) => f.endsWith(".jsonl"))
    .map((f: string) => {
      const id = f.replace(".jsonl", "");
      return getSession(id);
    })
    .filter((session: Session | null): session is Session => {
      if (!session) return false;
      if (ownerEmail === undefined) return true;
      return session.ownerEmail === ownerEmail;
    })
    .map((session: Session) => ({
      id: session.id,
      createdAt: session.createdAt,
      messageCount: session.messages.length,
      preview: extractPreview(session),
      permissionMode: session.permissionMode.mode,
      ownerEmail: session.ownerEmail,
    }))
    .sort((a: SessionInfo, b: SessionInfo) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

export function deleteSession(id: string): void {
  sessions.delete(id);
  const filePath = sessionPath(id);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export function appendMessage(sessionId: string, message: Message): void {
  appendLine(sessionId, { type: "message", ...message, timestamp: Date.now() });
}

/**
 * Record a compaction in the append-only log. Compaction REPLACES the whole
 * message list (with a summary + restored context), so a plain append would
 * leave the pre-compaction messages in the log and resurrect them on restore.
 * We write a `compacted` checkpoint; restoreFromDisk resets the in-memory
 * messages to this snapshot when it replays the line.
 */
export function appendCompaction(sessionId: string, messages: Message[]): void {
  appendLine(sessionId, {
    type: "compacted",
    messages,
    timestamp: Date.now(),
  });
}

export function appendModeChange(sessionId: string, session: Session): void {
  appendLine(sessionId, {
    type: "mode_changed",
    permissionMode: session.permissionMode,
    hasExitedPlanMode: session.hasExitedPlanMode ?? false,
    needsPlanModeExitAttachment: session.needsPlanModeExitAttachment ?? false,
    timestamp: Date.now(),
  });
}

function appendLine(sessionId: string, data: Record<string, unknown>): void {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.appendFileSync(sessionPath(sessionId), JSON.stringify(data) + "\n");
}

function restoreFromDisk(id: string): Session {
  const raw = fs.readFileSync(sessionPath(id), "utf-8").trim();
  const lines = raw.split("\n").map((l: string) => JSON.parse(l));

  const session: Session = {
    id,
    messages: [],
    createdAt: Date.now(),
    readFileState: new Map(),
    permissionMode: createDefaultPermissionMode(),
    hasExitedPlanMode: false,
    needsPlanModeExitAttachment: false,
  };

  for (const line of lines) {
    if (line.type === "session_created") {
      session.createdAt = line.createdAt;
      if (typeof line.ownerEmail === "string") {
        session.ownerEmail = line.ownerEmail;
      }
      if (line.permissionMode) {
        session.permissionMode = line.permissionMode as Session["permissionMode"];
      }
    } else if (line.type === "mode_changed") {
      if (line.permissionMode) {
        session.permissionMode = line.permissionMode as Session["permissionMode"];
      }
      if (typeof line.hasExitedPlanMode === "boolean") {
        session.hasExitedPlanMode = line.hasExitedPlanMode;
      }
      if (typeof line.needsPlanModeExitAttachment === "boolean") {
        session.needsPlanModeExitAttachment = line.needsPlanModeExitAttachment;
      }
    } else if (line.type === "compacted") {
      // Checkpoint: discard everything accumulated so far and adopt the
      // post-compaction snapshot. Subsequent `message` lines append normally.
      session.messages = Array.isArray(line.messages)
        ? (line.messages as Message[])
        : [];
    } else if (line.type === "message") {
      const { type: _, timestamp: __, ...msg } = line;
      session.messages.push(msg as Message);
    }
  }

  return session;
}
