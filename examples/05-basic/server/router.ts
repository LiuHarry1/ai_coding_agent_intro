import * as fs from "fs";
import * as path from "path";
import type { IncomingMessage, ServerResponse } from "http";
import { createSession, getSession, listSessions, deleteSession, appendMessage } from "./session.js";
import { createSSETransport } from "./sse-transport.js";
import { EventBus } from "../core/event-bus.js";
import { Middleware, createTimingMiddleware } from "../core/middleware.js";
import { defaultRegistry } from "../tools/index.js";
import { definition as exploreDef } from "../subagents/explore.js";
import type { RouterOptions, Message } from "../core/types.js";

defaultRegistry.register(exploreDef);

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function sendJSON(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export function createRouter({ runAgent, systemPrompt, staticDir }: RouterOptions) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
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

    // ── Session APIs ──────────────────────────────
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

    if (req.method === "DELETE" && req.url?.startsWith("/sessions/")) {
      const id = req.url.split("/sessions/")[1];
      deleteSession(id);
      sendJSON(res, 200, { deleted: id });
      return;
    }

    // ── Chat (SSE) ────────────────────────────────
    if (req.method === "POST" && req.url === "/chat") {
      let body: Record<string, unknown>;
      try {
        body = await readBody(req);
      } catch {
        sendJSON(res, 400, { error: "Invalid JSON" });
        return;
      }

      const { message, workspace, session_id } = body as {
        message?: string;
        workspace?: string;
        session_id?: string;
      };
      if (!message) {
        sendJSON(res, 400, { error: "Missing 'message' field" });
        return;
      }

      const cwd = workspace && fs.existsSync(workspace)
        ? path.resolve(workspace)
        : process.cwd();
      const prompt = systemPrompt(cwd);

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

      const eventBus = new EventBus();
      const middleware = new Middleware();
      const timing = createTimingMiddleware(eventBus);
      middleware.use("afterTool", timing.afterTool);

      const transport = createSSETransport(res, eventBus, { "X-Session-Id": session.id });
      transport.send("session", { session_id: session.id });

      req.on("close", () => {
        console.log("[server] client disconnected");
        eventBus.removeAllListeners();
      });

      const tools = defaultRegistry.createAll(cwd, {
        eventBus,
        middleware,
        runAgent,
        registry: defaultRegistry,
      });

      const messagesBefore = session.messages.length;

      await runAgent(message, {
        tools,
        systemPrompt: prompt,
        eventBus,
        messages: session.messages,
      });

      const newMessages = session.messages.slice(messagesBefore);
      for (const msg of newMessages) {
        appendMessage(session.id, msg as Message);
      }

      transport.end();
      return;
    }

    // ── Workspace browser ─────────────────────────
    if (req.method === "GET" && req.url?.startsWith("/workspace/list")) {
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
          .filter((d: fs.Dirent) => !d.name.startsWith("."))
          .map((d: fs.Dirent) => ({ name: d.name, isDir: d.isDirectory(), path: path.join(dir, d.name) }))
          .sort((a: { isDir: boolean; name: string }, b: { isDir: boolean; name: string }) =>
            a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)
          );
        sendJSON(res, 200, { dir, parent: path.dirname(dir), entries });
      } catch {
        sendJSON(res, 200, { dir, parent: path.dirname(dir), entries: [] });
      }
      return;
    }

    // ── Static files ──────────────────────────────
    if (staticDir) {
      const MIME_TYPES: Record<string, string> = {
        ".html": "text/html",
        ".css": "text/css",
        ".js": "application/javascript",
        ".jsx": "application/javascript",
        ".json": "application/json",
        ".png": "image/png",
        ".svg": "image/svg+xml",
        ".ico": "image/x-icon",
        ".woff2": "font/woff2",
        ".woff": "font/woff",
      };

      const urlPath = req.url === "/" ? "/index.html" : (req.url?.split("?")[0] ?? "/index.html");
      const filePath = path.join(staticDir, urlPath);

      if (req.method === "GET" && filePath.startsWith(staticDir) && fs.existsSync(filePath)) {
        const ext = path.extname(filePath);
        const mime = MIME_TYPES[ext] || "application/octet-stream";
        res.writeHead(200, { "Content-Type": mime });
        fs.createReadStream(filePath).pipe(res);
        return;
      }
    }

    sendJSON(res, 404, { error: "Not found" });
  };
}
