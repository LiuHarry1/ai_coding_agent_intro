import * as http from "http";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";
import { createSession, getSession, listSessions, appendMessage } from "./session.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.resolve(__dirname, "../../client/web");

const MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function sendJSON(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

/**
 * Server with session management.
 *
 * New endpoints vs shared/server.js:
 *   POST /chat        — now accepts optional `session_id` for multi-turn
 *   POST /sessions    — create a new session
 *   GET  /sessions    — list all sessions
 */
export function startServer({ runAgent, createTools, systemPrompt }) {
  const PORT = parseInt(process.env.PORT || "4567", 10);

  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      sendJSON(res, 200, { status: "ok" });
      return;
    }

    if (req.method === "GET" && req.url === "/workspace") {
      sendJSON(res, 200, { workspace: process.cwd() });
      return;
    }

    // ── Session endpoints ─────────────────────────────────
    if (req.method === "POST" && req.url === "/sessions") {
      const session = createSession();
      console.log(`[server] new session: ${session.id}`);
      sendJSON(res, 200, { session_id: session.id });
      return;
    }

    if (req.method === "GET" && req.url === "/sessions") {
      sendJSON(res, 200, { sessions: listSessions() });
      return;
    }

    // ── Chat with session support ─────────────────────────
    if (req.method === "POST" && req.url === "/chat") {
      let body;
      try {
        body = await readBody(req);
      } catch {
        sendJSON(res, 400, { error: "Invalid JSON" });
        return;
      }

      const { message, workspace, session_id } = body;
      if (!message) {
        sendJSON(res, 400, { error: "Missing 'message' field" });
        return;
      }

      const cwd = workspace && fs.existsSync(workspace) ? path.resolve(workspace) : process.cwd();
      const tools = createTools(cwd);
      const prompt = systemPrompt(cwd);

      // Get or create session
      let session;
      if (session_id) {
        session = getSession(session_id);
        if (!session) {
          sendJSON(res, 404, { error: `Session not found: ${session_id}` });
          return;
        }
      } else {
        session = createSession();
      }

      console.log(`[server] chat [session:${session.id.slice(0, 8)}] [${session.messages.length} prior msgs] ${message.slice(0, 80)}`);

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Session-Id": session.id,
      });


      // Send session_id to client so it can continue the conversation
      const sendSSE = (event, data) => {
        if (res.writableEnded) return;
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      sendSSE("session", { session_id: session.id });

      req.on("close", () => {
        console.log("[server] client disconnected");
      });

      const messagesBefore = session.messages.length;

      await runAgent(message, {
        tools,
        systemPrompt: prompt,
        sendSSE,
        messages: session.messages,
      });

      // Persist new messages to JSONL
      const newMessages = session.messages.slice(messagesBefore);
      for (const msg of newMessages) {
        appendMessage(session.id, msg);
      }

      res.end();
      return;
    }

    // ── Static files ──────────────────────────────────────
    if (req.method === "GET" && req.url.startsWith("/workspace/list")) {
      const params = new URL(req.url, `http://${req.headers.host}`).searchParams;
      let dir = params.get("dir") || process.cwd();
      dir = dir.replace(/^~/, process.env.HOME || "/");
      dir = path.resolve(dir);

      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        sendJSON(res, 200, { dir, parent: path.dirname(dir), entries: [] });
        return;
      }

      try {
        const raw = fs.readdirSync(dir, { withFileTypes: true });
        const entries = raw
          .filter((d) => !d.name.startsWith("."))
          .map((d) => ({ name: d.name, isDir: d.isDirectory(), path: path.join(dir, d.name) }))
          .sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));
        sendJSON(res, 200, { dir, parent: path.dirname(dir), entries });
      } catch {
        sendJSON(res, 200, { dir, parent: path.dirname(dir), entries: [] });
      }
      return;
    }

    const urlPath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
    const filePath = path.join(STATIC_DIR, urlPath);

    if (req.method === "GET" && filePath.startsWith(STATIC_DIR) && fs.existsSync(filePath)) {
      const ext = path.extname(filePath);
      const mime = MIME_TYPES[ext] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": mime });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    sendJSON(res, 404, { error: "Not found" });
  });

  server.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
    console.log(`[server]   POST /sessions   — create session`);
    console.log(`[server]   GET  /sessions   — list sessions`);
    console.log(`[server]   POST /chat       — chat (with session_id for multi-turn)`);
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[server] port ${PORT} is already in use.`);
    } else {
      console.error(`[server] error: ${err.message}`);
    }
    process.exit(1);
  });
}
