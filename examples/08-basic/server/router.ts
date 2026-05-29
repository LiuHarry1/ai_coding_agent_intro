import * as fs from "fs";
import * as path from "path";
import type { IncomingMessage, ServerResponse } from "http";
import { createSession, getSession, listSessions, deleteSession, appendMessage } from "./session.js";
import { createSSETransport } from "./sse-transport.js";
import { createWorkspaceRouter } from "./workspace/router.js";
import { createSkillsApi } from "./skills-api.js";
import { getDefaultWorkspace } from "../core/workspace.js";
import { EventBus } from "../core/event-bus.js";
import { Middleware, createTimingMiddleware } from "../core/middleware.js";
import { defaultRegistry } from "../tools/index.js";
import {
  registerBuiltinSubagents,
  registerSubagents,
  getSubagentNames,
} from "../agents/index.js";
import { registerSkills, formatSkillListing } from "../skills/index.js";
import { dispatchSlashCommand, listSlashCommands } from "../commands/dispatcher.js";
import { respondSkillFork } from "../skills/respond-fork.js";
import { MCPManager } from "../core/mcp-manager.js";
import { configManager } from "../core/config-manager.js";
import { answerQuestion } from "../core/question-broker.js";
import { loadProjectRules } from "../core/rules-loader.js";
import { filterToolsByEnablement } from "../core/tool-enablement.js";
import { buildConcurrencyPolicy } from "../core/concurrency-policy.js";
import { createToolSearchDefinition, TOOL_SEARCH_TOOL_NAME } from "../tools/tool_search.js";
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

  // Streaming defaults ON (back-compat with the UI). Callers that want a
  // single JSON blob ask explicitly via `?stream=false`, `stream:false`
  // in the body, or `Accept: application/json` — any one is enough.
  // Useful for scripts/CI/internal services that don't want to parse SSE.
  const urlQuery = new URLSearchParams(req.url?.split("?")[1] ?? "");
  const acceptsJSON = (req.headers["accept"] ?? "").includes(
    "application/json",
  );
  const wantsStream =
    urlQuery.get("stream") !== "false" &&
    body.stream !== false &&
    !acceptsJSON;

  const cwd = workspace && fs.existsSync(workspace)
    ? path.resolve(workspace)
    : getDefaultWorkspace();

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
  // circuit (built-in /help), feed the expanded body to the main agent
  // (inline command/skill), or fork into a subagent (skill `context: fork`).
  let effectiveMessage = message;
  let immediateReply: string | null = null;
  const slashResult = await dispatchSlashCommand(message, { cwd });
  if (slashResult.kind === "reply") {
    immediateReply = slashResult.text;
  } else if (slashResult.kind === "unknown") {
    immediateReply = `Unknown slash command: /${slashResult.name}\n\nTry /help to see all available commands.`;
  } else if (slashResult.kind === "run" && slashResult.mode === "inline") {
    effectiveMessage = slashResult.text;
    console.log(
      `[server] expanded /${slashResult.entry.name} (${slashResult.entry.kind}) → ${effectiveMessage.length} char prompt`,
    );
  }

  // ── Fork skill via slash (`/skill-name` with `context: fork`) ─────────
  // Handled BEFORE opening the main SSE transport — `respondSkillFork`
  // owns the response (writes its own headers / events).
  if (
    slashResult.kind === "run" &&
    slashResult.mode === "fork" &&
    slashResult.entry.kind === "skill"
  ) {
    console.log(
      `[server] fork skill /${slashResult.entry.name} → agent ${slashResult.entry.def.agent ?? "general_purpose"}`,
    );
    await respondSkillFork({
      res,
      skill: slashResult.entry.def,
      combined: slashResult.text,
      cwd,
      runAgent,
      wantsStream,
      sseHeaders: { "X-Session-Id": session.id },
      jsonMeta: { session_id: session.id, reason: "skill_fork" },
    });
    return;
  }

  const eventBus = new EventBus();
  const middleware = new Middleware();
  middleware.use("afterTool", createTimingMiddleware(eventBus).afterTool);

  // SSE transport is only created in streaming mode. For JSON mode we
  // keep the eventBus around (the agent loop still uses it internally
  // for tool middleware) but never wire it to the response — there's
  // no place to send events when the caller wants one final blob.
  const transport = wantsStream
    ? createSSETransport(res, eventBus, { "X-Session-Id": session.id })
    : null;
  transport?.send("session", { session_id: session.id });

  req.on("close", () => {
    console.log("[server] client disconnected");
    eventBus.removeAllListeners();
  });

  // Short-circuit built-in slash-command replies. SSE path mirrors a
  // normal chat turn; JSON path returns one shot.
  if (immediateReply !== null) {
    if (transport) {
      transport.send("text_delta", { delta: immediateReply });
      transport.send("finish", { reason: "slash_command" });
      transport.end();
    } else {
      sendJSON(res, 200, {
        session_id: session.id,
        text: immediateReply,
        reason: "slash_command",
      });
    }
    return;
  }

  // ── Per-request markdown extension reload ──────────────────────────────
  // Re-scan .ai-agent/{agents,skills}/ for the current cwd so edits to user-
  // authored definitions take effect on the NEXT message without a server
  // restart. Both register/replace dispatcher tools on `defaultRegistry`.
  // Cheap (~1ms per kind for tens of files). Reloaded each turn
  // `getAgentDefinitionsWithOverrides` invocation.
  const { activeAgents } = await registerSubagents(defaultRegistry, cwd);
  // Extract file-path-shaped tokens from the user's message so skills
  // declaring `paths:` frontmatter can opt in for relevant turns only
    // request instead of per file-tool-call). Cheap regex — won't catch
  // every reference, but matches the common case of users naming files
  // explicitly. Skills without `paths:` are unaffected.
  const candidateFiles = extractFilePathCandidates(effectiveMessage);
  const { activeSkills, allSkills } = await registerSkills(
    defaultRegistry,
    cwd,
    activeAgents,
    { candidateFiles },
  );
  const conditionalHidden = allSkills.length - activeSkills.length;
  console.log(
    `[server] cwd=${cwd}  agents=[${activeAgents.map(a => a.agentType).join(", ")}]  skills=[${activeSkills.map(s => s.name).join(", ")}]${conditionalHidden > 0 ? `  (+${conditionalHidden} conditional hidden)` : ""}`,
  );

  const projectRules = loadProjectRules(cwd);

  const enablement = configManager.getAll();
  const toolEnablement = { disabledTools: enablement.disabledTools };

  const toolContext = {
    eventBus,
    middleware,
    runAgent,
    registry: defaultRegistry,
    mcpTools: mcpManager.getAllTools(),
    toolEnablement,
    sessionId: session.id,
  };

  // Split built-in + MCP tools into active vs deferred pools.
  // Tools previously discovered in this session stay active.
  const { active, deferred, deferredDefs } = defaultRegistry.createSplit(
    cwd,
    toolContext,
    mcpManager.getAllTools(),
    session.discoveredTools,
  );

  // If there are deferred tools, register tool_search as an always-active tool
  // so the model can discover them on demand.
  if (deferredDefs.length > 0) {
    const tsearchDef = createToolSearchDefinition(deferredDefs);
    active[TOOL_SEARCH_TOOL_NAME] = tsearchDef.create(cwd, toolContext);
  }

  const tools = filterToolsByEnablement(active, defaultRegistry, toolEnablement);

  const messagesBefore = session.messages.length;

  // Build the <system-reminder> content:
  // 1) Skill listing (same as before)
  // 2) Deferred-tool listing (new: names only, tells model to use tool_search)
  const reminderParts: string[] = [];

  if (activeSkills.length > 0) {
    reminderParts.push(
      `The following skills are available for use with the skill tool:\n\n${formatSkillListing(activeSkills)}`,
    );
  }

  if (deferredDefs.length > 0) {
    const listing = deferredDefs
      .map((d) => `- ${d.name}${d.isMcp ? " (MCP)" : ""}`)
      .join("\n");
    reminderParts.push(
      `The following tools are available but not loaded. Use \`tool_search\` to discover and load them before use:\n${listing}`,
    );
  }

  const skillListing = reminderParts.length > 0
    ? reminderParts.join("\n\n")
    : undefined;

  console.log(
    `[server] tools: ${Object.keys(tools).length} active, ${deferredDefs.length} deferred${session.discoveredTools?.size ? `, ${session.discoveredTools.size} previously discovered` : ""}`,
  );

  // Track tools discovered via tool_search so they stay active in future turns.
  const unsubDiscover = eventBus.on("tools_discovered", (data) => {
    const names = (data as { tools: string[] }).tools;
    if (!session.discoveredTools) session.discoveredTools = new Set();
    for (const n of names) session.discoveredTools.add(n);
  });

  let finalText = "";
  let runError: Error | null = null;
  try {
    finalText = await runAgent(effectiveMessage, {
      tools,
      systemPrompt: systemPrompt(cwd, projectRules || undefined),
      eventBus,
      messages: session.messages,
      images: images?.length ? images : undefined,
      subagentNames: getSubagentNames(defaultRegistry),
      skillListing,
      deferredToolPool: Object.keys(deferred).length > 0 ? deferred : undefined,
      concurrencyPolicy: buildConcurrencyPolicy(defaultRegistry, Object.keys(tools)),
      sessionId: session.id,
    });
  } catch (e) {
    runError = e as Error;
  } finally {
    unsubDiscover();
  }

  for (const msg of session.messages.slice(messagesBefore)) {
    appendMessage(session.id, msg as Message);
  }

  if (transport) {
    if (runError) transport.send("error", { message: runError.message });
    transport.end();
  } else {
    if (runError) {
      sendJSON(res, 500, {
        session_id: session.id,
        error: runError.message,
      });
    } else {
      sendJSON(res, 200, {
        session_id: session.id,
        text: finalText,
        // Echo the new messages so callers that persist their own history
        // can append without re-fetching /sessions/:id/messages.
        messages: sessionToUIMessages(session.messages.slice(messagesBefore)),
      });
    }
  }
}

/**
 * Pull file-path-shaped tokens out of free-form user text. Used to feed
 * `registerSkills`' conditional `paths:` activation — we want a cheap,
 * permissive extractor here, not a parser. Matches paths with a
 * directory separator OR a recognizable extension, plus paths inside
 * backticks (the most common "this file" syntax). False positives are
 * fine — skills that don't match just stay hidden.
 */
function extractFilePathCandidates(text: string): string[] {
  if (!text) return [];
  const out = new Set<string>();
  // Backtick-quoted spans (`src/foo.ts`, `./run.sh`). Anything inside
  // backticks containing a `.` or `/` is plausibly a path.
  const backtickRe = /`([^`\n]{1,256})`/g;
  for (const m of text.matchAll(backtickRe)) {
    const candidate = m[1]!.trim();
    if (/[./\\]/.test(candidate) && !candidate.includes(" ")) {
      out.add(candidate);
    }
  }
  // Bare path-like tokens: at least one slash OR an extension. Anchored
  // at non-word so we don't grab the tail of an email/URL.
  const bareRe =
    /(?<![\w@/:])([./\w-]+\/[\w./-]+|[\w-]+\.[A-Za-z][\w]{0,9})(?![\w/])/g;
  for (const m of text.matchAll(bareRe)) {
    out.add(m[1]!);
  }
  return [...out];
}

/** Internal agent context - must not appear in the chat UI. */
function isSystemReminderContent(content: string): boolean {
  const t = content.trim();
  return t.startsWith("<system-reminder>") && t.endsWith("</system-reminder>");
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
      if (isSystemReminderContent(content)) continue;
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
  const workspaceRouter = createWorkspaceRouter({ root: getDefaultWorkspace() });

  // Direct skill / agent invocation API for "other internal projects"
  // calling this backend as a service. Lives in its own module so the
  // router stays a thin dispatch table. See server/skills-api.ts.
  const skillsApi = createSkillsApi({ runAgent });

  return async (req: IncomingMessage, res: ServerResponse) => {
    setCORS(res);

    const { method, url } = req;

    if (method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    if (method === "GET" && url === "/health") { sendJSON(res, 200, { status: "ok" }); return; }

    // Slash autocomplete for the web UI — merged commands + skills.
    if (method === "GET" && url?.startsWith("/slash-commands")) {
      const query = new URLSearchParams(url.split("?")[1] ?? "");
      const workspace = query.get("workspace");
      const cwd =
        workspace && fs.existsSync(workspace)
          ? path.resolve(workspace)
          : getDefaultWorkspace();
      try {
        const entries = await listSlashCommands(cwd);
        sendJSON(res, 200, { workspace: cwd, entries });
      } catch (e) {
        sendJSON(res, 500, { error: (e as Error).message });
      }
      return;
    }

    if (await workspaceRouter(req, res)) return;

    if (await skillsApi(req, res)) return;

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

    if (method === "POST" && url?.split("?")[0] === "/chat") {
      await handleChat(req, res, runAgent, systemPrompt);
      return;
    }

    if (staticDir && serveStaticFile(req, res, staticDir)) return;

    sendJSON(res, 404, { error: "Not found" });
  };
}
