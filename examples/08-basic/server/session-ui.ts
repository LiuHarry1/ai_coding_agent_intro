import type { Message } from "../core/types.js";
import { getSubagentNames } from "../tools/AgentTool/index.js";
import { defaultRegistry } from "../tools/index.js";

function isSystemReminderContent(content: string): boolean {
  const t = content.trim();
  return t.startsWith("<system-reminder>") && t.endsWith("</system-reminder>");
}

type UIAssistantMessage = {
  type: "assistant";
  parts: Array<{ type: string; toolCallId?: string; result?: string }>;
  status: "done";
};

/** Append one stored assistant message's displayable parts onto a UI turn. */
function appendAssistantParts(
  target: UIAssistantMessage,
  content: Array<{
    type: string;
    text?: string;
    toolCallId?: string;
    toolName?: string;
    input?: unknown;
  }>,
  subagentNames: Set<string>,
): void {
  for (const part of content) {
    if (part.type === "text" && part.text?.trim()) {
      target.parts.push({ type: "text", content: part.text });
    } else if (part.type === "reasoning" && part.text?.trim()) {
      target.parts.push({ type: "reasoning", content: part.text, status: "done" });
    } else if (part.type === "tool-call") {
      target.parts.push({
        type: "tool_call",
        name: part.toolName,
        toolCallId: part.toolCallId,
        args: part.input,
        status: "done",
        isSubagent: subagentNames.has(part.toolName ?? ""),
      });
    }
  }
}

/**
 * Convert agent messages to flat UI format for the web client.
 *
 * One user turn can produce many stored assistant/tool messages (tool-call →
 * tool-result → tool-call …). While streaming, the frontend accumulates all of
 * those into a single assistant bubble; merge consecutive assistant parts here
 * so session reload matches that layout.
 */
export function sessionToUIMessages(messages: Message[]): unknown[] {
  const uiMessages: unknown[] = [];
  const subagentNames = getSubagentNames(defaultRegistry);
  let currentAssistant: UIAssistantMessage | null = null;

  for (const msg of messages) {
    if (msg.role === "user") {
      currentAssistant = null;
      const content =
        typeof msg.content === "string"
          ? msg.content
          : (msg.content as Array<{ type: string; text?: string }>)
              .filter((p) => p.type === "text")
              .map((p) => p.text)
              .join("");
      if (isSystemReminderContent(content)) continue;
      uiMessages.push({ type: "user", content });
    } else if (msg.role === "assistant") {
      if (!currentAssistant) {
        currentAssistant = { type: "assistant", parts: [], status: "done" };
        uiMessages.push(currentAssistant);
      }
      appendAssistantParts(
        currentAssistant,
        msg.content as Array<{
          type: string;
          text?: string;
          toolCallId?: string;
          toolName?: string;
          input?: unknown;
        }>,
        subagentNames,
      );
    } else if (msg.role === "tool") {
      if (currentAssistant) {
        for (const tr of msg.content as Array<{
          type: string;
          toolCallId: string;
          toolName: string;
          output: { value: string };
        }>) {
          const tc = currentAssistant.parts.find(
            (p) => p.type === "tool_call" && p.toolCallId === tr.toolCallId,
          );
          if (tc) tc.result = tr.output?.value ?? "";
        }
      }
    }
  }

  return uiMessages;
}
