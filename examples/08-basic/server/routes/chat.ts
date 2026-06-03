import * as fs from "fs";
import * as path from "path";
import type { IncomingMessage, ServerResponse } from "http";
import {
  createSession,
  getSession,
  appendMessage,
} from "../session.js";
import { createSSETransport } from "../sse-transport.js";
import { readBody, sendJSON, wantsStreamingResponse } from "../http.js";
import { sessionToUIMessages } from "../session-ui.js";
import { getDefaultWorkspace } from "../../core/workspace.js";
import { EventBus } from "../../core/event-bus.js";
import { Middleware, createTimingMiddleware } from "../../core/middleware.js";
import { defaultRegistry } from "../../tools/index.js";
import { respondSkillFork } from "../../skills/respond-fork.js";
import { configManager } from "../../core/config-manager.js";
import { prepareChatTurn } from "../../process_input/prepare_chat_turn.js";
import { mcpManager } from "../mcp-lifecycle.js";
import type { Message, RunAgentFn } from "../../core/types.js";

export async function handleChat(
  req: IncomingMessage,
  res: ServerResponse,
  runAgent: RunAgentFn,
  systemPrompt: (cwd: string, projectRules?: string) => string,
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

  const wantsStream = wantsStreamingResponse(req, body);
  const cwd =
    workspace && fs.existsSync(workspace)
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

  console.log(
    `[server] chat [session:${session.id.slice(0, 8)}] [${session.messages.length} prior msgs] ${message.slice(0, 80)}`,
  );

  const eventBus = new EventBus();
  const middleware = new Middleware();
  middleware.use("afterTool", createTimingMiddleware(eventBus).afterTool);

  const prepared = await prepareChatTurn({
    message,
    cwd,
    session,
    registry: defaultRegistry,
    mcpManager,
    configManager,
    eventBus,
    middleware,
    runAgent,
  });

  if (prepared.forkSkill) {
    console.log(
      `[server] fork skill /${prepared.forkSkill.entry.name} → agent ${prepared.forkSkill.entry.def.agent ?? "general_purpose"}`,
    );
    await respondSkillFork({
      res,
      skill: prepared.forkSkill.entry.def,
      combined: prepared.forkSkill.text,
      cwd,
      runAgent,
      wantsStream,
      sseHeaders: { "X-Session-Id": session.id },
      jsonMeta: { session_id: session.id, reason: "skill_fork" },
    });
    return;
  }

  const transport = wantsStream
    ? createSSETransport(res, eventBus, { "X-Session-Id": session.id })
    : null;
  transport?.send("session", { session_id: session.id });

  req.on("close", () => {
    console.log("[server] client disconnected");
    eventBus.removeAllListeners();
  });

  if (prepared.immediateReply !== null) {
    if (transport) {
      transport.send("text_delta", { delta: prepared.immediateReply });
      transport.send("finish", { reason: "slash_command" });
      transport.end();
    } else {
      sendJSON(res, 200, {
        session_id: session.id,
        text: prepared.immediateReply,
        reason: "slash_command",
      });
    }
    return;
  }

  const unsubDiscover = eventBus.on("tools_discovered", (data) => {
    const names = (data as { tools: string[] }).tools;
    if (!session.discoveredTools) session.discoveredTools = new Set();
    for (const n of names) session.discoveredTools.add(n);
  });

  const messagesBefore = session.messages.length;
  let finalText = "";
  let runError: Error | null = null;

  try {
    finalText = await runAgent(prepared.effectiveMessage, {
      tools: prepared.tools,
      systemPrompt: systemPrompt(cwd, prepared.projectRules || undefined),
      eventBus,
      messages: session.messages,
      images: images?.length ? images : undefined,
      subagentNames: prepared.subagentNames,
      skillListing: prepared.skillListing,
      deferredToolPool: prepared.deferredToolPool,
      concurrencyPolicy: prepared.concurrencyPolicy,
      sessionId: session.id,
      attachmentMessages:
        prepared.attachmentMessages.length > 0
          ? prepared.attachmentMessages
          : undefined,
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
  } else if (runError) {
    sendJSON(res, 500, {
      session_id: session.id,
      error: runError.message,
    });
  } else {
    sendJSON(res, 200, {
      session_id: session.id,
      text: finalText,
      messages: sessionToUIMessages(session.messages.slice(messagesBefore)),
    });
  }
}
