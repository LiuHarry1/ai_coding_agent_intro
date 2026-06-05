import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import type { Session, SessionInfo, Message } from "../core/types.js";
import { createDefaultPermissionMode } from "../core/permission-mode.js";
import type { ExternalMode } from "../core/permission-mode.js";

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

export function createSession(): Session {
  const id = randomUUID();
  const session: Session = {
    id,
    messages: [],
    createdAt: Date.now(),
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
    permissionMode: session.permissionMode,
  });
  return session;
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

export function listSessions(): SessionInfo[] {
  if (!fs.existsSync(SESSION_DIR)) return [];
  return fs
    .readdirSync(SESSION_DIR)
    .filter((f: string) => f.endsWith(".jsonl"))
    .map((f: string) => {
      const id = f.replace(".jsonl", "");
      const session = getSession(id);
      return {
        id,
        createdAt: session?.createdAt,
        messageCount: session?.messages.length ?? 0,
        preview: extractPreview(session),
        permissionMode: session?.permissionMode.mode,
      };
    })
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
    } else if (line.type === "message") {
      const { type: _, timestamp: __, ...msg } = line;
      session.messages.push(msg as Message);
    }
  }

  return session;
}
