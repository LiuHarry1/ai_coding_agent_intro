import type { Message } from "../core/types.js";
import { getSubagentNames } from "../tools/AgentTool/index.js";
import { defaultRegistry } from "../tools/index.js";

function isSystemReminderContent(content: string): boolean {
  const t = content.trim();
  return t.startsWith("<system-reminder>") && t.endsWith("</system-reminder>");
}

/** Convert agent messages to flat UI format for the web client. */
export function sessionToUIMessages(messages: Message[]): unknown[] {
  const uiMessages: unknown[] = [];
  const subagentNames = getSubagentNames(defaultRegistry);

  for (const msg of messages) {
    if (msg.role === "user") {
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
      const parts: unknown[] = [];
      for (const part of msg.content as Array<{
        type: string;
        text?: string;
        toolCallId?: string;
        toolName?: string;
        input?: unknown;
      }>) {
        if (part.type === "text" && part.text) {
          parts.push({ type: "text", content: part.text });
        } else if (part.type === "reasoning" && part.text) {
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
      const lastAssistant = uiMessages[uiMessages.length - 1] as
        | {
            type: string;
            parts: Array<{ type: string; toolCallId?: string; result?: string }>;
          }
        | undefined;
      if (lastAssistant?.type === "assistant") {
        for (const tr of msg.content as Array<{
          type: string;
          toolCallId: string;
          toolName: string;
          output: { value: string };
        }>) {
          const tc = lastAssistant.parts.find(
            (p) => p.type === "tool_call" && p.toolCallId === tr.toolCallId,
          );
          if (tc) tc.result = tr.output?.value ?? "";
        }
      }
    }
  }

  return uiMessages;
}
