import * as fs from "fs";
import * as path from "path";
import type { IncomingMessage, ServerResponse } from "http";
import { createSession, getSession, listSessions, deleteSession, appendMessage } from "./session.js";
import { createSSETransport } from "./sse-transport.js";
import { EventBus } from "../core/event-bus.js";
import { Middleware, createTimingMiddleware } from "../core/middleware.js";
import { defaultRegistry } from "../tools/index.js";
import { definition as exploreDef } from "../subagents/explore.js";
import { MCPManager, resolveMCPConfigPath } from "../core/mcp-manager.js";
import { loadProjectRules } from "../core/rules-loader.js";
import type { RouterOptions, Message, RunAgentFn, MCPServerConfig } from "../core/types.js";

defaultRegistry.register(exploreDef);

const mcpManager = new MCPManager();

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

const MAX_BODY_SIZE = 20 * 1024 * 1024; // 20MB for base64 images

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_SIZE) { req.destroy(); reject(new Error("Body too large")); return; }
      chunks.push(c);
    });
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

function setCORS(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function handleWorkspaceList(req: IncomingMessage, res: ServerResponse): void {
  const params = new URL(req.url!, `http://${req.headers.host}`).searchParams;
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
}

function serveStaticFile(req: IncomingMessage, res: ServerResponse, staticDir: string): boolean {
  const urlPath = req.url === "/" ? "/index.html" : (req.url?.split("?")[0] ?? "/index.html");
  const filePath = path.join(staticDir, urlPath);

  if (req.method !== "GET" || !filePath.startsWith(staticDir) || !fs.existsSync(filePath)) {
    return false;
  }

  const ext = path.extname(filePath);
  res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

async function handleChat(
  req: IncomingMessage,
  res: ServerResponse,
  runAgent: RunAgentFn,
  systemPrompt: (cwd: string, projectRules?: string) => string
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readBody(req);
  } catch {
    sendJSON(res, 400, { error: "Invalid JSON" });
    return;
  }

  const { message, workspace, session_id, images } = body as {
    message?: string;
    workspace?: string;
    session_id?: string;
    images?: string[];
  };
  if (!message) {
    sendJSON(res, 400, { error: "Missing 'message' field" });
    return;
  }

  const cwd = workspace && fs.existsSync(workspace)
    ? path.resolve(workspace)
    : process.cwd();

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
  middleware.use("afterTool", createTimingMiddleware(eventBus).afterTool);

  const transport = createSSETransport(res, eventBus, { "X-Session-Id": session.id });
  transport.send("session", { session_id: session.id });

  req.on("close", () => {
    console.log("[server] client disconnected");
    eventBus.removeAllListeners();
  });

  const projectRules = loadProjectRules(cwd);

  const localTools = defaultRegistry.createAll(cwd, {
    eventBus,
    middleware,
    runAgent,
    registry: defaultRegistry,
  });
  const mcpTools = mcpManager.getAllTools();
  const tools = { ...localTools, ...mcpTools };

  const messagesBefore = session.messages.length;

  await runAgent(message, {
    tools,
    systemPrompt: systemPrompt(cwd, projectRules || undefined),
    eventBus,
    messages: session.messages,
    images: images?.length ? images : undefined,
  });

  for (const msg of session.messages.slice(messagesBefore)) {
    appendMessage(session.id, msg as Message);
  }

  transport.end();
}

async function handleMCPAdd(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try { body = await readBody(req); } catch { sendJSON(res, 400, { error: "Invalid JSON" }); return; }

  const name = body.name as string;
  const config = body.config as MCPServerConfig;
  if (!name || !config) {
    sendJSON(res, 400, { error: "Missing 'name' and/or 'config'" });
    return;
  }

  await mcpManager.addServer(name, config);
  sendJSON(res, 200, { status: mcpManager.getStatus() });
}

async function handleMCPRemove(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try { body = await readBody(req); } catch { sendJSON(res, 400, { error: "Invalid JSON" }); return; }

  const name = body.name as string;
  if (!name) { sendJSON(res, 400, { error: "Missing 'name'" }); return; }

  await mcpManager.removeServer(name);
  sendJSON(res, 200, { status: mcpManager.getStatus() });
}

export function createRouter({ runAgent, systemPrompt, staticDir }: RouterOptions) {
  // Load MCP config on startup (non-blocking)
  const configPath = resolveMCPConfigPath(process.cwd());
  mcpManager.loadConfig(configPath).catch((err) => {
    console.error(`[mcp] Failed to load config: ${err.message}`);
  });

  process.on("exit", () => { mcpManager.closeAll().catch(() => {}); });

  return async (req: IncomingMessage, res: ServerResponse) => {
    setCORS(res);

    const { method, url } = req;

    if (method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    if (method === "GET" && url === "/health") { sendJSON(res, 200, { status: "ok" }); return; }
    if (method === "GET" && url === "/workspace") { sendJSON(res, 200, { workspace: process.cwd() }); return; }

    if (method === "POST" && url === "/sessions") {
      const session = createSession();
      console.log(`[server] new session: ${session.id}`);
      sendJSON(res, 200, { session_id: session.id });
      return;
    }
    if (method === "GET" && url === "/sessions") { sendJSON(res, 200, { sessions: listSessions() }); return; }
    if (method === "DELETE" && url?.startsWith("/sessions/")) {
      const id = url.split("/sessions/")[1];
      deleteSession(id);
      sendJSON(res, 200, { deleted: id });
      return;
    }

    // ── MCP endpoints ──
    if (method === "GET" && url === "/mcp") { sendJSON(res, 200, { servers: mcpManager.getStatus() }); return; }
    if (method === "POST" && url === "/mcp/add") { await handleMCPAdd(req, res); return; }
    if (method === "POST" && url === "/mcp/remove") { await handleMCPRemove(req, res); return; }
    if (method === "POST" && url === "/mcp/reload") {
      await mcpManager.closeAll();
      await mcpManager.loadConfig(configPath);
      sendJSON(res, 200, { servers: mcpManager.getStatus() });
      return;
    }

    if (method === "POST" && url === "/chat") { await handleChat(req, res, runAgent, systemPrompt); return; }
    if (method === "GET" && url?.startsWith("/workspace/list")) { handleWorkspaceList(req, res); return; }

    if (staticDir && serveStaticFile(req, res, staticDir)) return;

    sendJSON(res, 404, { error: "Not found" });
  };
}
