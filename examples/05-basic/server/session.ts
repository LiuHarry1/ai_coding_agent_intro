import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import type { Session, SessionInfo, Message } from "../core/types.js";

const SESSION_DIR = path.resolve(".sessions");
const sessions = new Map<string, Session>();

function sessionPath(id: string): string {
  return path.join(SESSION_DIR, `${id}.jsonl`);
}

export function createSession(): Session {
  const id = randomUUID();
  const session: Session = { id, messages: [], createdAt: Date.now() };
  sessions.set(id, session);
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  appendLine(id, { type: "session_created", id, createdAt: session.createdAt });
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

function appendLine(sessionId: string, data: Record<string, unknown>): void {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.appendFileSync(sessionPath(sessionId), JSON.stringify(data) + "\n");
}

function restoreFromDisk(id: string): Session {
  const raw = fs.readFileSync(sessionPath(id), "utf-8").trim();
  const lines = raw.split("\n").map((l: string) => JSON.parse(l));

  const session: Session = { id, messages: [], createdAt: Date.now() };

  for (const line of lines) {
    if (line.type === "session_created") {
      session.createdAt = line.createdAt;
    } else if (line.type === "message") {
      const { type: _, timestamp: __, ...msg } = line;
      session.messages.push(msg as Message);
    }
  }

  return session;
}
