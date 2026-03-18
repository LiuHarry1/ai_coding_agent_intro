import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

// ── Session Store ─────────────────────────────────────────────
//
// Two layers:
//   1. In-memory Map for fast access during runtime
//   2. JSONL files on disk for persistence across restarts
//
// This is the same pattern Claude Code uses:
//   ~/.claude/projects/<project>/sessions/<uuid>.jsonl

const SESSION_DIR = path.resolve(".sessions");

const sessions = new Map();

function sessionPath(id) {
  return path.join(SESSION_DIR, `${id}.jsonl`);
}

export function createSession() {
  const id = randomUUID();
  const session = { id, messages: [], createdAt: Date.now() };
  sessions.set(id, session);
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  appendLine(id, { type: "session_created", id, createdAt: session.createdAt });
  return session;
}

export function getSession(id) {
  if (sessions.has(id)) return sessions.get(id);

  const filePath = sessionPath(id);
  if (!fs.existsSync(filePath)) return null;

  const session = restoreFromDisk(id);
  sessions.set(id, session);
  return session;
}

export function listSessions() {
  if (!fs.existsSync(SESSION_DIR)) return [];
  return fs.readdirSync(SESSION_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const id = f.replace(".jsonl", "");
      const session = getSession(id);
      return {
        id,
        createdAt: session?.createdAt,
        messageCount: session?.messages.length ?? 0,
      };
    })
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

// ── Persistence: append to JSONL ──────────────────────────────

export function appendMessage(sessionId, message) {
  appendLine(sessionId, { type: "message", ...message, timestamp: Date.now() });
}

function appendLine(sessionId, data) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.appendFileSync(sessionPath(sessionId), JSON.stringify(data) + "\n");
}

// ── Restore: rebuild messages from JSONL ──────────────────────

function restoreFromDisk(id) {
  const raw = fs.readFileSync(sessionPath(id), "utf-8").trim();
  const lines = raw.split("\n").map((l) => JSON.parse(l));

  const session = { id, messages: [], createdAt: Date.now() };

  for (const line of lines) {
    if (line.type === "session_created") {
      session.createdAt = line.createdAt;
    } else if (line.type === "message") {
      const { type, timestamp, ...msg } = line;
      session.messages.push(msg);
    }
  }

  return session;
}
