import { generateText } from "ai";
import { createProvider } from "../../shared/provider.js";

const provider = createProvider();

// ── Feature 1: Tool Output Truncation (Microcompaction) ───────────
//
// Tool outputs (bash results, file contents) dominate the context window.
// OpenCode's data: 81% of storage is tool output.
//
// Strategy: keep the last `hotTail` tool results fully intact.
// Older tool results get replaced with a one-line summary.

const HOT_TAIL = 4;
const MAX_TOOL_OUTPUT_CHARS = 200;

export function truncateToolOutputs(messages) {
  const toolIndices = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "tool") toolIndices.push(i);
  }

  const coldCount = toolIndices.length - HOT_TAIL;
  if (coldCount <= 0) return;

  for (let k = 0; k < coldCount; k++) {
    const msg = messages[toolIndices[k]];
    if (!Array.isArray(msg.content)) continue;

    for (const part of msg.content) {
      if (part.type !== "tool-result") continue;
      const val = part.output?.value ?? "";
      if (val.length <= MAX_TOOL_OUTPUT_CHARS) continue;

      part.output = {
        type: "text",
        value: `[truncated: ${val.length} chars from ${part.toolName}]`,
      };
    }
  }
}

// ── Feature 2: Conversation Summarization ─────────────────────────
//
// When messages grow too long, summarize the older portion into a
// single "summary" message, keeping recent messages intact.
//
// This is what Claude Code calls "compaction" and Aider calls
// "chat history summarization."

const SUMMARIZE_THRESHOLD = 20;
const KEEP_RECENT = 6;

const SUMMARIZE_PROMPT = `You are a conversation summarizer for a coding agent session.
Summarize the conversation into a concise working state. Your summary MUST include:

1. **Task**: What the user asked for
2. **Progress**: What has been done so far (files created/modified, commands run)
3. **Current state**: Where things stand right now
4. **Key decisions**: Important technical choices made
5. **Errors & fixes**: Any errors encountered and how they were resolved

Be specific — include file paths, function names, and exact details.
Output only the summary, no preamble.`;

export async function summarizeIfNeeded(messages, sendSSE) {
  if (messages.length < SUMMARIZE_THRESHOLD) return false;

  const splitAt = messages.length - KEEP_RECENT;
  const oldMessages = messages.slice(0, splitAt);

  sendSSE("context_management", {
    action: "summarize",
    messageCount: messages.length,
    summarizing: oldMessages.length,
    keeping: KEEP_RECENT,
  });

  const conversationText = oldMessages
    .map((m) => {
      if (typeof m.content === "string") return `[${m.role}] ${m.content}`;
      if (Array.isArray(m.content)) {
        return m.content
          .map((p) => {
            if (p.type === "text") return `[${m.role}] ${p.text}`;
            if (p.type === "tool-call") return `[${m.role}] called ${p.toolName}(${JSON.stringify(p.input).slice(0, 200)})`;
            if (p.type === "tool-result") {
              const val = p.output?.value ?? "";
              return `[tool:${p.toolName}] ${val.slice(0, 300)}`;
            }
            return "";
          })
          .filter(Boolean)
          .join("\n");
      }
      return `[${m.role}] ${JSON.stringify(m.content).slice(0, 200)}`;
    })
    .join("\n");

  const { text: summary } = await generateText({
    model: provider.chatModel("gpt-4.1-nano"),
    system: SUMMARIZE_PROMPT,
    messages: [{ role: "user", content: conversationText }],
    maxTokens: 1024,
  });

  const recentMessages = messages.slice(splitAt);

  messages.length = 0;
  messages.push({
    role: "user",
    content:
      `[This conversation was compacted. Summary of earlier messages below]\n\n${summary}\n\n` +
      `[End of summary — continue from here]`,
  });
  messages.push({ role: "assistant", content: [{ type: "text", text: "Understood. I have the context from the summary. Continuing." }] });
  messages.push(...recentMessages);

  sendSSE("context_management", {
    action: "summarized",
    oldMessageCount: oldMessages.length,
    summaryLength: summary.length,
    newMessageCount: messages.length,
  });

  return true;
}
