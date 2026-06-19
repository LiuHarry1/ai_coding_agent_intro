/**
 * LLM summarization engine for full compaction.
 * summarizes ALL messages (no tail preservation), then re-injects
 * recently-read file contents, todo list, and skill references.
 */
import * as fs from "fs";
import * as path from "path";
import { generateText } from "ai";
import { defaultManager } from "../../core/provider-manager.js";
import type { Message, TodoItem } from "../../core/types.js";
import { READ_FILE_TOOL_NAME } from "../../constants/tool_names.js";
import { estimateConversationTokens, clearTokenUsages } from "./tokens.js";

// ── Prompt (analysis + summary) ─────────────────────────

const SUMMARY_SYSTEM = `You are compacting an AI coding agent's conversation to save context space.

CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
Your entire response must be an <analysis> block followed by a <summary> block.

Before providing your summary, wrap your analysis in <analysis> tags:
1. Chronologically analyze the conversation. For each section identify:
   - The user's explicit requests and intents
   - Key decisions, technical concepts and code patterns
   - Specific file names, code snippets, function signatures, file edits
   - Errors encountered and how they were fixed
   - User feedback that changed direction
2. Double-check for technical accuracy and completeness.

Your <summary> should include these sections:

1. Primary Request and Intent: What the user asked for in detail.
2. Key Technical Concepts: Technologies, frameworks, patterns discussed.
3. Files and Code Sections: Each file examined/modified/created with:
   - Why it matters
   - Summary of changes
   - Key code snippets where useful
4. Errors and Fixes: Each error, how it was fixed, user feedback if any.
5. Problem Solving: Problems solved and ongoing troubleshooting.
6. All User Messages: Non-tool-result user messages (critical for understanding changing intent).
7. Pending Tasks: Explicitly requested tasks with status.
8. Current Work: What was being worked on immediately before compaction. Include file names and code snippets.
9. Optional Next Step: Only if directly in line with the user's most recent explicit request. Include direct quotes showing where you left off.

Rules:
- Be SPECIFIC: include file paths, line counts, error messages, test results
- Focus on WHAT EXISTS NOW, not the history of how it got there
- Include full code snippets for recently modified code
- Pay special attention to the most recent messages`;

// ── File restoration config ─────────────────────────────

export interface FileRestoreConfig {
  maxFiles: number;
  maxTokensPerFile: number;
  totalBudget: number;
}

// ── Public API ──────────────────────────────────────────

export interface CompactResult {
  messages: Message[];
  summaryLength: number;
  estimatedTokensAfter: number;
}

export interface CompactContext {
  cwd: string;
  todos: TodoItem[];
  fileRestore: FileRestoreConfig;
}

const MAX_SUMMARIZE_RETRIES = 1;

/**
 * Summarize ALL messages via LLM, then build a fresh post-compact context
 * with re-injected files, todos, and a "continue without asking" instruction.
 *
 * Returns null if summarization fails.
 */
export async function compactConversation(
  messages: Message[],
  model: string,
  ctx: CompactContext,
): Promise<CompactResult | null> {
  if (messages.length < 2) return null;

  let formatted = messages.map(formatForSummary).join("\n\n---\n\n");
  let summary: string | undefined;

  for (let attempt = 0; attempt <= MAX_SUMMARIZE_RETRIES; attempt++) {
    try {
      const provider = defaultManager.get();
      const result = await generateText({
        model: provider.chatModel(model),
        system: SUMMARY_SYSTEM,
        messages: [
          {
            role: "user",
            content: `Compact the following agent conversation into a structured summary:\n\n${formatted}`,
          },
        ],
      });
      summary = formatCompactSummary(result.text);
      break;
    } catch (error) {
      if (attempt < MAX_SUMMARIZE_RETRIES && isLikelyTooLong(error)) {
        const truncateAt = Math.floor(messages.length * 0.3);
        const reduced = messages.slice(truncateAt);
        formatted = reduced.map(formatForSummary).join("\n\n---\n\n");
        console.warn(`[compact] PTL recovery: truncated ${truncateAt} oldest msgs, retrying`);
        continue;
      }
      throw error;
    }
  }

  if (!summary) return null;

  clearTokenUsages(messages);

  const recentFiles = extractRecentlyReadFiles(messages);
  const fileSection = restoreRecentFiles(recentFiles, ctx.cwd, ctx.fileRestore);
  const built = buildPostCompactMessages(summary, fileSection, ctx.todos);

  return {
    messages: built,
    summaryLength: summary.length,
    estimatedTokensAfter: estimateConversationTokens(built),
  };
}

// ── Post-compact message construction ───────────────────

function buildPostCompactMessages(
  summary: string,
  fileSection: string,
  todos: TodoItem[],
): Message[] {
  let content = `[Previous conversation compacted — context continues below]\n\n${summary}`;

  if (fileSection) {
    content += `\n\n${fileSection}`;
  }

  if (todos.length > 0) {
    const todoLines = todos.map((t) => `- [${t.status}] ${t.id}: ${t.content}`);
    content += `\n\n## Active Todo List\nUpdate via todo_write(merge=true) as you complete items:\n${todoLines.join("\n")}`;
  }

  content += `\n\nContinue from where you left off without asking questions. Resume directly — do not acknowledge the summary, do not recap what was happening. Pick up the last task as if the break never happened.`;

  return [{ role: "user", content }];
}

// ── File restoration ────────────────────────────────────

function extractRecentlyReadFiles(messages: Message[], maxFiles = 8): string[] {
  const files: string[] = [];
  for (let i = messages.length - 1; i >= 0 && files.length < maxFiles; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    for (const part of m.content) {
      if (part.type !== "tool-call" || part.toolName !== READ_FILE_TOOL_NAME) continue;
      const filePath =
        (part.input as Record<string, unknown>)?.file_path as string | undefined ??
        (part.input as Record<string, unknown>)?.path as string | undefined;
      if (filePath && !files.includes(filePath)) {
        files.push(filePath);
      }
    }
  }
  return files;
}

function restoreRecentFiles(
  recentPaths: string[],
  cwd: string,
  config: FileRestoreConfig,
): string {
  if (recentPaths.length === 0) return "";

  const maxCharPerFile = config.maxTokensPerFile * 4;
  const totalCharBudget = config.totalBudget * 4;
  let usedChars = 0;
  const sections: string[] = [];

  for (const filePath of recentPaths.slice(0, config.maxFiles)) {
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
    try {
      if (!fs.existsSync(abs)) continue;
      const stat = fs.statSync(abs);
      if (stat.isDirectory() || stat.size > 512 * 1024) continue;

      let content = fs.readFileSync(abs, "utf-8");
      if (content.length > maxCharPerFile) {
        content = content.slice(0, maxCharPerFile) + "\n[... truncated for compaction]";
      }

      if (usedChars + content.length > totalCharBudget) break;
      usedChars += content.length;

      sections.push(`### ${filePath}\n\`\`\`\n${content}\n\`\`\``);
    } catch {
      continue;
    }
  }

  if (sections.length === 0) return "";
  return `## Restored File Contents\nThese files were recently accessed. Their current content is included so you can continue working immediately.\n\n${sections.join("\n\n")}`;
}

// ── Format compact summary (strip analysis scratchpad) ──

function formatCompactSummary(raw: string): string {
  let result = raw;
  result = result.replace(/<analysis>[\s\S]*?<\/analysis>/, "");
  const summaryMatch = result.match(/<summary>([\s\S]*?)<\/summary>/);
  if (summaryMatch) {
    result = summaryMatch[1]!.trim();
  }
  result = result.replace(/\n\n\n+/g, "\n\n");
  return result.trim();
}

// ── Formatting helpers ──────────────────────────────────

function formatForSummary(msg: Message): string {
  if (msg.role === "user") {
    if (typeof msg.content === "string") return `USER: ${msg.content}`;
    const text = msg.content
      .map((p) => (p.type === "text" ? p.text : "[image]"))
      .filter(Boolean)
      .join("\n");
    return `USER: ${text}`;
  }

  if (msg.role === "assistant") {
    const formatted = msg.content
      .map((p) => {
        if (p.type === "text") return p.text;
        if (p.type === "reasoning") return "";
        if (p.type === "tool-call") {
          const args = JSON.stringify(p.input || {});
          const short = args.length > 300 ? args.slice(0, 300) + "..." : args;
          return `[Called ${p.toolName}(${short})]`;
        }
        return "";
      })
      .filter(Boolean);
    return `ASSISTANT: ${formatted.join("\n")}`;
  }

  return msg.content
    .map((p) => {
      const v = p.output?.value ?? "";
      const text = typeof v === "string" ? v : JSON.stringify(v);
      const short = text.length > 500 ? text.slice(0, 500) + "..." : text;
      return `[${p.toolName} result]: ${short}`;
    })
    .join("\n");
}

function isLikelyTooLong(err: unknown): boolean {
  if (!err) return false;
  const e = err as { statusCode?: number; status?: number; message?: string };
  const status = e.statusCode ?? e.status;
  if (status === 413) return true;
  const msg = (e.message ?? "").toLowerCase();
  return msg.includes("context length") || msg.includes("too long") || msg.includes("token");
}
