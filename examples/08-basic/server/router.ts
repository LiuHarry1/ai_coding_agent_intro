import * as fs from "fs";
import * as path from "path";
import type { IncomingMessage, ServerResponse } from "http";
import { createSession, getSession, listSessions, deleteSession, appendMessage } from "./session.js";
import { createSSETransport } from "./sse-transport.js";
import { createWorkspaceRouter } from "./workspace/router.js";
import { EventBus } from "../core/event-bus.js";
import { Middleware, createTimingMiddleware } from "../core/middleware.js";
import { defaultRegistry } from "../tools/index.js";
import {
  registerBuiltinSubagents,
  registerSubagents,
  getSubagentNames,
} from "../subagents/index.js";
import { registerSkills } from "../skills/index.js";
import { dispatchSlashCommand } from "../commands/dispatcher.js";
import { MCPManager } from "../core/mcp-manager.js";
import { configManager } from "../core/config-manager.js";
import { answerQuestion } from "../core/question-broker.js";
import { loadProjectRules } from "../core/rules-loader.js";
import { filterToolsByEnablement } from "../core/tool-enablement.js";
import type { RouterOptions, Message, RunAgentFn, MCPServerConfig, LlmProfile } from "../core/types.js";

registerBuiltinSubagents(defaultRegistry);

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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
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

  // ── Slash-command resolution (pre-SSE, no LLM round-trip yet) ──────────
  // Resolve /xxx BEFORE opening the SSE stream so we know whether to short-
  // circuit (built-in /help) or feed the expanded body to the agent.
  let effectiveMessage = message;
  let immediateReply: string | null = null;
  const slashResult = await dispatchSlashCommand(message, { cwd });
  if (slashResult.kind === "reply") {
    immediateReply = slashResult.text;
  } else if (slashResult.kind === "unknown") {
    immediateReply = `Unknown slash command: /${slashResult.name}\n\nTry /help to see all available commands.`;
  } else if (slashResult.kind === "expanded") {
    effectiveMessage = slashResult.text;
    console.log(
      `[server] expanded /${slashResult.command.name} → ${effectiveMessage.length} char prompt`,
    );
  }

  const eventBus = new EventBus();
  const middleware = new Middleware();
  middleware.use("afterTool", createTimingMiddleware(eventBus).afterTool);

  const transport = createSSETransport(res, eventBus, { "X-Session-Id": session.id });
  transport.send("session", { session_id: session.id });

  req.on("close", () => {
    console.log("[server] client disconnected");
    eventBus.removeAllListeners();
  });

  // Short-circuit built-in slash-command replies via SSE so the frontend's
  // event-source plumbing stays identical to a normal chat turn.
  if (immediateReply !== null) {
    transport.send("text_delta", { delta: immediateReply });
    transport.send("finish", { reason: "slash_command" });
    transport.end();
    return;
  }

  // ── Per-request markdown extension reload ──────────────────────────────
  // Re-scan .agents/ and .skills/ for the current cwd so edits to user-
  // authored definitions take effect on the NEXT message without a server
  // restart. Both register/replace dispatcher tools on `defaultRegistry`.
  // Cheap (~1ms per kind for tens of files). Mirrors CC's per-turn
  // `getAgentDefinitionsWithOverrides` invocation.
  const { activeAgents } = await registerSubagents(defaultRegistry, cwd);
  const { activeSkills } = await registerSkills(defaultRegistry, cwd, activeAgents);
  console.log(
    `[server] cwd=${cwd}  agents=[${activeAgents.map(a => a.agentType).join(", ")}]  skills=[${activeSkills.map(s => s.name).join(", ")}]`,
  );

  const projectRules = loadProjectRules(cwd);

  const enablement = configManager.getAll();
  const toolEnablement = { disabledTools: enablement.disabledTools };

  const localTools = defaultRegistry.createAll(cwd, {
    eventBus,
    middleware,
    runAgent,
    registry: defaultRegistry,
    mcpTools: mcpManager.getAllTools(),
    toolEnablement,
  });
  const mcpTools = mcpManager.getAllTools();
  const merged = { ...localTools, ...mcpTools };
  const tools = filterToolsByEnablement(merged, defaultRegistry, toolEnablement);

  const messagesBefore = session.messages.length;

  await runAgent(effectiveMessage, {
    tools,
    systemPrompt: systemPrompt(cwd, projectRules || undefined),
    eventBus,
    messages: session.messages,
    images: images?.length ? images : undefined,
    // Forwarded so the agent can tag `tool_call` events with isSubagent:true
    // for the UI's SubagentCard rendering.
    subagentNames: getSubagentNames(defaultRegistry),
  });

  for (const msg of session.messages.slice(messagesBefore)) {
    appendMessage(session.id, msg as Message);
  }

  transport.end();
}

/**
 * Convert AI SDK messages (user/assistant/tool) into the flat UI format
 * that the frontend MessageBubble component expects.
 */
function sessionToUIMessages(messages: Message[]): unknown[] {
  const uiMessages: unknown[] = [];

  // Subagent identity is intrinsic to the tool definition, not the per-call
  // payload — the AI SDK doesn't persist it on disk. Recover it from the
  // registry. Without this, refreshing the page after a long session
  // reverts every explore/plan card to the generic ToolCallCard.
  const subagentNames = getSubagentNames(defaultRegistry);

  for (const msg of messages) {
    if (msg.role === "user") {
      const content = typeof msg.content === "string"
        ? msg.content
        : (msg.content as Array<{ type: string; text?: string }>)
            .filter((p) => p.type === "text")
            .map((p) => p.text)
            .join("");
      uiMessages.push({ type: "user", content });
    } else if (msg.role === "assistant") {
      const parts: unknown[] = [];
      for (const part of msg.content as Array<{ type: string; text?: string; toolCallId?: string; toolName?: string; input?: unknown }>) {
        if (part.type === "text" && part.text) {
          parts.push({ type: "text", content: part.text });
        } else if (part.type === "reasoning" && part.text) {
          // ReasoningPart was sanitized in agent.ts to only carry the
          // summary text; surface it to the frontend's <ReasoningBlock>.
          parts.push({ type: "reasoning", content: part.text, status: "done" });
        } else if (part.type === "tool-call") {
          parts.push({
            type: "tool_call",
            name: part.toolName,
            toolCallId: part.toolCallId,
            args: part.input,
            status: "done",
            isSubagent: subagentNames.has(part.toolName ?? ""),
          });
        }
      }
      uiMessages.push({ type: "assistant", parts, status: "done" });
    } else if (msg.role === "tool") {
      const lastAssistant = uiMessages[uiMessages.length - 1] as { type: string; parts: Array<{ type: string; toolCallId?: string; result?: string }> } | undefined;
      if (lastAssistant?.type === "assistant") {
        for (const tr of msg.content as Array<{ type: string; toolCallId: string; toolName: string; output: { value: string } }>) {
          const tc = lastAssistant.parts.find(
            (p) => p.type === "tool_call" && p.toolCallId === tr.toolCallId
          );
          if (tc) {
            tc.result = tr.output?.value ?? "";
          }
        }
      }
    }
  }

  return uiMessages;
}

// ── MCP ↔ ConfigManager sync ──

async function syncMCPFromConfig(): Promise<void> {
  await mcpManager.closeAll();
  const servers = configManager.get("mcpServers");
  for (const [name, config] of Object.entries(servers)) {
    await mcpManager.addServer(name, config);
  }
}

export function createRouter({ runAgent, systemPrompt, staticDir }: RouterOptions) {
  // Load config, then connect MCP servers from config
  configManager.load();
  syncMCPFromConfig().catch((err) => {
    console.error(`[mcp] Failed to sync from config: ${err.message}`);
  });

  configManager.onChange("mcpServers", () => {
    syncMCPFromConfig().catch((err) => {
      console.error(`[mcp] Failed to re-sync after config change: ${err.message}`);
    });
  });

  process.on("exit", () => { mcpManager.closeAll().catch(() => {}); });

  // Workspace HTTP module — independent of agent/session/MCP. Composed by
  // delegation: it returns true iff it handled the request.
  const workspaceRouter = createWorkspaceRouter({ root: process.cwd() });

  return async (req: IncomingMessage, res: ServerResponse) => {
    setCORS(res);

    const { method, url } = req;

    if (method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    if (method === "GET" && url === "/health") { sendJSON(res, 200, { status: "ok" }); return; }

    if (await workspaceRouter(req, res)) return;

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
    if (method === "GET" && url?.match(/^\/sessions\/[^/]+\/messages$/)) {
      const id = url.split("/sessions/")[1].split("/messages")[0];
      const session = getSession(id);
      if (!session) { sendJSON(res, 404, { error: "Session not found" }); return; }
      sendJSON(res, 200, { messages: sessionToUIMessages(session.messages) });
      return;
    }

    // ── Settings endpoints ──
    if (method === "GET" && url === "/settings") {
      sendJSON(res, 200, {
        ...configManager.getSafe(),
        mcpStatus: mcpManager.getStatus(),
        configPath: configManager.configPath,
      });
      return;
    }
    if (method === "PATCH" && url === "/settings/provider") {
      try {
        const body = await readBody(req);
        configManager.patch("provider", body as Partial<LlmProfile>);
        sendJSON(res, 200, { provider: configManager.getSafe().provider });
      } catch { sendJSON(res, 400, { error: "Invalid JSON" }); }
      return;
    }
    if (method === "PATCH" && url === "/settings/mcp") {
      try {
        const body = await readBody(req);
        const action = body.action as string;

        if (action === "add") {
          const name = body.name as string;
          const config = body.config as MCPServerConfig;
          if (!name || !config) { sendJSON(res, 400, { error: "Missing 'name' and/or 'config'" }); return; }
          const servers = configManager.get("mcpServers");
          servers[name] = config;
          configManager.set("mcpServers", servers);
        } else if (action === "remove") {
          const name = body.name as string;
          if (!name) { sendJSON(res, 400, { error: "Missing 'name'" }); return; }
          const servers = configManager.get("mcpServers");
          delete servers[name];
          configManager.set("mcpServers", servers);
        } else {
          sendJSON(res, 400, { error: "action must be 'add' or 'remove'" });
          return;
        }

        sendJSON(res, 200, {
          mcpServers: configManager.get("mcpServers"),
          mcpStatus: mcpManager.getStatus(),
        });
      } catch { sendJSON(res, 400, { error: "Invalid JSON" }); }
      return;
    }

    // ── Legacy MCP endpoints (backward compatible) ──
    if (method === "GET" && url === "/mcp") { sendJSON(res, 200, { servers: mcpManager.getStatus() }); return; }

    // Answer a pending ask_user_question prompt. Body shape:
    //   { id, answers: { [questionText]: answerString }, annotations? }
    // Multi-select answers should be joined by ", " by the client
    // before posting.
    if (method === "POST" && url === "/ask_user_question/answer") {
      try {
        const body = await readBody(req);
        const id = body.id as string;
        const answers = body.answers as Record<string, string> | undefined;
        const annotations = body.annotations as
          | Record<string, { preview?: string; notes?: string }>
          | undefined;
        if (!id || !answers || typeof answers !== "object") {
          sendJSON(res, 400, { error: "Missing 'id' or 'answers' object" });
          return;
        }
        const ok = answerQuestion(id, { answers, annotations });
        sendJSON(
          res,
          ok ? 200 : 404,
          ok ? { ok: true } : { error: "No pending question with that id" }
        );
      } catch { sendJSON(res, 400, { error: "Invalid JSON" }); }
      return;
    }

    if (method === "POST" && url === "/chat") { await handleChat(req, res, runAgent, systemPrompt); return; }

    if (staticDir && serveStaticFile(req, res, staticDir)) return;

    sendJSON(res, 404, { error: "Not found" });
  };
}
