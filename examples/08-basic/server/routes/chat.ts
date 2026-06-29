import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";
import {
  createSession,
  getSession,
  appendMessage,
  appendModeChange,
  appendCompaction,
  canAccessSession,
} from "../session.js";
import { compactIfNeeded, tokenCountWithEstimation } from "../../services/compact/index.js";
import { defaultManager } from "../../core/provider-manager.js";
import { createSSETransport } from "../sse-transport.js";
import { readBody, sendJSON, wantsStreamingResponse } from "../http.js";
import { sessionToUIMessages } from "../session-ui.js";
import { getDefaultWorkspace } from "../../core/workspace.js";
import type { AuthedRequest } from "../auth/identity.js";
import { EventBus } from "../../core/event-bus.js";
import { Middleware, createTimingMiddleware } from "../../core/middleware/index.js";
import { applyPluginHooks, hasPluginHooks } from "../../core/plugins/index.js";
import { createPlanModeGuardMiddleware } from "../../core/middleware/plan-mode-guard.js";
import { defaultRegistry } from "../../tools/index.js";
import { respondSkillFork } from "../../skills/respond-fork.js";
import { attachUsageTelemetry, flushUsage, reportUserQuestion } from "../telemetry.js";
import {
  checkQuota,
  commitQuota,
  shouldEnforceQuota,
  trackTurnTokens,
} from "../quota.js";
import { configManager } from "../../core/config-manager.js";
import { prepareChatTurn } from "../../utils/processUserInput/prepare_chat_turn.js";
import { mcpManager } from "../mcp-lifecycle.js";
import {
  handlePlanModeTransition,
  isValidExternalMode,
  transitionPermissionMode,
} from "../../core/permission-mode.js";
import { getSystemPromptForMode } from "../../prompts/mode.js";
import { applyModeRestrictions } from "../../core/mode-restrictions.js";
import { planExists } from "../../utils/plans.js";
import type { Message, RunAgentFn } from "../../core/types.js";

export async function handleChat(
  req: IncomingMessage,
  res: ServerResponse,
  runAgent: RunAgentFn,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readBody(req);
  } catch {
    sendJSON(res, 400, { error: "Invalid JSON" });
    return;
  }

  const { message, workspace, session_id, images, mode } = body as {
    message?: string;
    workspace?: string;
    session_id?: string;
    images?: string[];
    mode?: string;
  };
  if (!message) {
    sendJSON(res, 400, { error: "Missing 'message' field" });
    return;
  }

  const wantsStream = wantsStreamingResponse(req, body);
  // When auth is on, the workspace is pinned to the authenticated user
  // (set by the router's auth gate); the client-supplied `workspace` is
  // intentionally ignored so a user cannot escape their own directory.
  const cwd =
    (req as AuthedRequest).userWorkspace ??
    (workspace && fs.existsSync(workspace)
      ? path.resolve(workspace)
      : getDefaultWorkspace());

  const requesterEmail = (req as AuthedRequest).user?.email;
  let session;
  if (session_id) {
    session = getSession(session_id);
    if (!session || !canAccessSession(session, requesterEmail, (req as AuthedRequest).user?.role)) {
      sendJSON(res, 404, { error: `Session not found: ${session_id}` });
      return;
    }
  } else {
    session = createSession(requesterEmail);
  }

  if (!session.permissionMode) {
    session.permissionMode = { mode: "agent" };
  }

  if (mode && isValidExternalMode(mode) && mode !== session.permissionMode.mode) {
    const from = session.permissionMode.mode;
    handlePlanModeTransition(from, mode, session);
    session.permissionMode = transitionPermissionMode(from, mode, session.permissionMode);
    appendModeChange(session.id, session);
  }

  console.log(
    `[server] chat [session:${session.id.slice(0, 8)}] [mode:${session.permissionMode.mode}] [${session.messages.length} prior msgs] ${message.slice(0, 80)}`,
  );

  const eventBus = new EventBus();
  const telemetryCtx = {
    sessionId: session.id,
    userEmail: session.ownerEmail,
  };
  const requesterRole = (req as AuthedRequest).user?.role;
  const quotaUser = session.ownerEmail ?? requesterEmail;
  const quotaEventId = `${session.id}:chat:${randomUUID()}`;
  const turnUsage = { tokens: 0 };
  const unsubTurnTokens = trackTurnTokens(eventBus, turnUsage);

  const finishQuota = async (): Promise<void> => {
    unsubTurnTokens();
    if (shouldEnforceQuota(quotaUser, requesterRole)) {
      try {
        await commitQuota(quotaUser!, turnUsage.tokens, quotaEventId);
      } catch (err) {
        console.warn(`[quota] commit failed: ${(err as Error).message}`);
      }
    }
  };

  if (shouldEnforceQuota(quotaUser, requesterRole)) {
    try {
      const q = await checkQuota(quotaUser!);
      if (q.exceeded) {
        unsubTurnTokens();
        sendJSON(res, 429, {
          error: "Daily token limit exceeded",
          quota: q,
        });
        return;
      }
    } catch (err) {
      console.warn(`[quota] status check failed: ${(err as Error).message}`);
      // Fail open if analytics is unreachable — chat still works.
    }
  }

  // One analytics event per user chat POST (question count).
  reportUserQuestion(telemetryCtx, session.messages.length, message);
  // Ship per-step LLM usage to analytics (no-op unless ANALYTICS_URL is set).
  const unsubTelemetry = attachUsageTelemetry(eventBus, telemetryCtx);
  const middleware = new Middleware();
  middleware.use("afterTool", createTimingMiddleware(eventBus).afterTool);
  middleware.use("beforeTool", createPlanModeGuardMiddleware(session, cwd));
  // Replay hooks/subscriptions registered by code plugins at boot (skip the
  // call entirely when no code plugin registered anything).
  if (hasPluginHooks()) applyPluginHooks(middleware, eventBus);

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
    unsubTelemetry();
    await finishQuota();
    return;
  }

  const sseHeaders: Record<string, string> = {
    "X-Session-Id": session.id,
    "X-Permission-Mode": session.permissionMode.mode,
  };

  // Opt-in protocol framing: `?protocol=1` makes the SSE stream carry
  // @ai-agent/protocol ServerMessages instead of the legacy event pairs.
  // Default is unchanged, so the existing web UI keeps working.
  const useProtocol =
    new URLSearchParams(req.url?.split("?")[1] ?? "").get("protocol") === "1";

  const transport = wantsStream
    ? createSSETransport(res, eventBus, sseHeaders, {
        protocol: useProtocol,
        sessionId: session.id,
        mode: session.permissionMode.mode,
      })
    : null;
  transport?.send("session", {
    session_id: session.id,
    mode: session.permissionMode.mode,
  });
  transport?.send("mode_changed", { mode: session.permissionMode.mode });

  if (prepared.modeChanged) {
    appendModeChange(session.id, session);
    transport?.send("mode_changed", { mode: session.permissionMode.mode });
  }

  const unsubMode = eventBus.on("mode_changed", (data) => {
    const newMode = (data as { mode: string }).mode;
    if (newMode && isValidExternalMode(newMode)) {
      appendModeChange(session.id, session);
      transport?.send("mode_changed", { mode: newMode });
    }
  });

  req.on("close", () => {
    console.log("[server] client disconnected");
    eventBus.removeAllListeners();
  });

  // Manual /compact: summarize the existing history now (no agent run). Runs
  // force-compaction over the whole session, persists a compaction checkpoint,
  // then returns a short status line. Token-pressure events stream over SSE.
  if (prepared.manualCompact) {
    const instructions = prepared.manualCompact.instructions.trim();
    const msgsBefore = session.messages.length;
    const tokensBefore = tokenCountWithEstimation(session.messages).total;
    let replyText: string;
    try {
      const model = defaultManager.get().defaultModelId();
      const managed = await compactIfNeeded(
        session.messages,
        eventBus,
        model,
        cwd,
        [],
        { force: true, instructions: instructions || undefined },
        session.id,
      );
      if (managed !== session.messages && managed.length > 0) {
        session.messages.length = 0;
        session.messages.push(...managed);
        appendCompaction(session.id, session.messages);
        const tokensAfter = tokenCountWithEstimation(session.messages).total;
        const tokenLine = `~${tokensBefore.toLocaleString()} → ~${tokensAfter.toLocaleString()} tokens`;
        // Full summarization collapses everything to a single message. If more
        // than one remains, only micro-compaction ran (the LLM summary step
        // failed or returned nothing) — report that honestly.
        if (session.messages.length === 1) {
          replyText =
            `Compacted: ${msgsBefore} → 1 message, ${tokenLine}.` +
            (instructions ? `\nFocus: ${instructions}` : "");
        } else {
          replyText =
            `Partially compacted (full summary unavailable — cleared old tool ` +
            `outputs only): ${msgsBefore} → ${session.messages.length} messages, ${tokenLine}.`;
        }
      } else {
        replyText =
          msgsBefore < 2
            ? "Nothing to compact yet — the conversation is too short."
            : "Compaction did not reduce the conversation (summarizer returned no change).";
      }
    } catch (e) {
      replyText = `Compaction failed: ${(e as Error).message}`;
    }

    if (transport) {
      transport.send("text_delta", { delta: replyText });
      transport.send("finish", { reason: "compact" });
      transport.end();
    } else {
      sendJSON(res, 200, {
        session_id: session.id,
        mode: session.permissionMode.mode,
        text: replyText,
        reason: "compact",
      });
    }
    unsubMode();
    unsubTelemetry();
    await finishQuota();
    void flushUsage();
    return;
  }

  if (prepared.immediateReply !== null) {
    if (transport) {
      transport.send("text_delta", { delta: prepared.immediateReply });
      transport.send("finish", { reason: "slash_command" });
      transport.end();
    } else {
      sendJSON(res, 200, {
        session_id: session.id,
        mode: session.permissionMode.mode,
        text: prepared.immediateReply,
        reason: "slash_command",
      });
    }
    unsubMode();
    unsubTelemetry();
    await finishQuota();
    void flushUsage();
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

  const promptOptions = {
    planFilePath: prepared.planFilePath,
    planExists: planExists(session, cwd),
  };

  const systemPrompt = getSystemPromptForMode(
    session.permissionMode.mode,
    cwd,
    prepared.projectRules || undefined,
    promptOptions,
  );

  const refreshTools = () =>
    applyModeRestrictions(
      session.permissionMode.mode,
      prepared.baseTools,
      prepared.modeTools,
    );

  const refreshSystemPrompt = () =>
    getSystemPromptForMode(
      session.permissionMode.mode,
      cwd,
      prepared.projectRules || undefined,
      {
        planFilePath: prepared.planFilePath,
        planExists: planExists(session, cwd),
      },
    );

  try {
    finalText = await runAgent(prepared.effectiveMessage, {
      tools: prepared.tools,
      systemPrompt,
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
      refreshTools,
      refreshSystemPrompt,
    });
  } catch (e) {
    runError = e as Error;
  } finally {
    unsubDiscover();
    unsubMode();
    unsubTelemetry();
    await finishQuota();
    void flushUsage();
  }

  for (const msg of session.messages.slice(messagesBefore)) {
    appendMessage(session.id, msg as Message);
  }

  if (transport) {
    if (runError) transport.send("error", { message: runError.message });
    transport.send("done", { mode: session.permissionMode.mode });
    transport.end();
  } else if (runError) {
    sendJSON(res, 500, {
      session_id: session.id,
      mode: session.permissionMode.mode,
      error: runError.message,
    });
  } else {
    sendJSON(res, 200, {
      session_id: session.id,
      mode: session.permissionMode.mode,
      text: finalText,
      messages: sessionToUIMessages(session.messages.slice(messagesBefore)),
    });
  }
}
