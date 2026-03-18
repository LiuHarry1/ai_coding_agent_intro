import * as fs from "fs";
import * as path from "path";
import { generateText } from "ai";
import { createProvider } from "../../shared/provider.js";

const provider = createProvider();

function resolvePath(cwd, filePath) {
  const abs = path.resolve(cwd, filePath);
  if (!abs.startsWith(cwd)) return null;
  return abs;
}

// ── Feature 1: Tool Output Truncation (Microcompaction) ───────────
//
// Tool outputs (bash results, file contents) dominate the context window.
// OpenCode's data: 81% of storage is tool output.
//
// Strategy: keep the last `hotTail` tool results fully intact.
// Older tool results get replaced with a one-line summary.

const HOT_TAIL = 6;
const MAX_TOOL_OUTPUT_CHARS = 200;

function getToolInputForResult(messages, toolMsgIdx, toolCallId) {
  for (let i = toolMsgIdx - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const p of m.content) {
      if (p.type === "tool-call" && p.toolCallId === toolCallId) return p.input;
    }
  }
  return null;
}

export function truncateToolOutputs(messages) {
  const toolIndices = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "tool") toolIndices.push(i);
  }

  const coldCount = toolIndices.length - HOT_TAIL;
  if (coldCount <= 0) return;

  for (let k = 0; k < coldCount; k++) {
    const idx = toolIndices[k];
    const msg = messages[idx];
    if (!Array.isArray(msg.content)) continue;

    for (const part of msg.content) {
      if (part.type !== "tool-result") continue;
      const val = part.output?.value ?? "";
      if (val.length <= MAX_TOOL_OUTPUT_CHARS) continue;

      const input = getToolInputForResult(messages, idx, part.toolCallId);
      const hint =
        part.toolName === "read_file" && input?.file_path
          ? `read_file("${input.file_path}")`
          : part.toolName === "bash" && input?.command
            ? `bash: ${String(input.command).slice(0, 50)}…`
            : part.toolName;

      part.output = {
        type: "text",
        value:
          `[truncated: ${hint} — ${val.length} chars. Use summary and recent context; re-read only with offset/limit if you need a specific section.]`,
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
const REHYDRATE_MAX_FILES = 4;
const REHYDRATE_MAX_LINES_PER_FILE = 150;

function getRecentlyReadPaths(messages, limit = REHYDRATE_MAX_FILES) {
  const paths = [];
  const seen = new Set();
  for (let i = messages.length - 1; i >= 0 && paths.length < limit; i--) {
    const m = messages[i];
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const p of m.content) {
      if (p.type === "tool-call" && p.toolName === "read_file" && p.input?.file_path) {
        const fp = p.input.file_path;
        if (!seen.has(fp)) {
          seen.add(fp);
          paths.unshift(fp);
        }
      }
    }
  }
  return paths.slice(-limit);
}

function readFileSafe(cwd, filePath, maxLines = REHYDRATE_MAX_LINES_PER_FILE) {
  const abs = resolvePath(cwd, filePath);
  if (!abs || !fs.existsSync(abs)) return null;
  try {
    const stat = fs.statSync(abs);
    if (stat.isDirectory() || stat.size > 512 * 1024) return null;
    const buf = fs.readFileSync(abs, "utf-8");
    const lines = buf.split("\n");
    const slice = lines.slice(0, maxLines);
    const head = slice.join("\n");
    const total = lines.length;
    return total > maxLines ? `${head}\n\n... [${total - maxLines} more lines]` : head;
  } catch {
    return null;
  }
}

const SUMMARIZE_PROMPT = `You are a conversation summarizer for a coding agent session.
Summarize the conversation into a concise working state. Your summary MUST include:

1. **Task**: What the user asked for
2. **Progress**: What has been done so far (files created/modified, commands run)
3. **Current state**: Where things stand right now
4. **Key decisions**: Important technical choices made
5. **Errors & fixes**: Any errors encountered and how they were resolved

Be specific — include file paths, function names, and exact details.
Output only the summary, no preamble.`;

export async function summarizeIfNeeded(messages, sendSSE, cwd = null) {
  if (messages.length < SUMMARIZE_THRESHOLD) return false;

  let splitAt = messages.length - KEEP_RECENT;
  // Ensure we never start recentMessages with a "tool" message — the API requires
  // every tool message to follow an assistant message with tool_calls.
  while (splitAt < messages.length && messages[splitAt]?.role === "tool") {
    splitAt--;
    if (splitAt < 0) break;
  }
  splitAt = Math.max(0, splitAt);

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
    model: provider.chatModel("gpt-4"),
    system: SUMMARIZE_PROMPT,
    messages: [{ role: "user", content: conversationText }],
    maxTokens: 1024,
  });

  let recentMessages = messages.slice(splitAt);
  // Strip any leading orphaned tool messages (e.g. corrupt state or splitAt=0)
  while (recentMessages.length > 0 && recentMessages[0]?.role === "tool") {
    recentMessages = recentMessages.slice(1);
  }

  // Rehydrate: re-read the last few files that were read, so the agent has them back without re-calling read_file
  let rehydratedBlock = "";
  if (cwd) {
    const paths = getRecentlyReadPaths(oldMessages);
    const parts = [];
    for (const fp of paths) {
      const content = readFileSafe(cwd, fp);
      if (content) parts.push(`### ${fp}\n\`\`\`\n${content}\n\`\`\``);
    }
    if (parts.length > 0) {
      rehydratedBlock =
        `\n\n[Rehydrated — these files were recently read; you have them in context, no need to read_file again]\n\n${parts.join("\n\n")}`;
      sendSSE("context_management", { action: "rehydrated", fileCount: parts.length, paths });
    }
  }

  messages.length = 0;
  messages.push({
    role: "user",
    content:
      `[This conversation was compacted. Summary of earlier messages below]\n\n${summary}` +
      rehydratedBlock +
      `\n\n[End of summary — continue from here]`,
  });
  messages.push({ role: "assistant", content: [{ type: "text", text: "Understood. I have the context from the summary and the rehydrated files. Continuing." }] });
  messages.push(...recentMessages);

  sendSSE("context_management", {
    action: "summarized",
    oldMessageCount: oldMessages.length,
    summaryLength: summary.length,
    newMessageCount: messages.length,
  });

  return true;
}
