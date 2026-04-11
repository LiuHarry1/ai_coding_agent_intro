import { generateText } from "ai";
import { defaultManager } from "./provider-manager.js";
import type { IEventBus, Message } from "./types.js";

const SUMMARIZE_THRESHOLD = parseInt(process.env.COMPACT_THRESHOLD || "40", 10);
const KEEP_RECENT = parseInt(process.env.COMPACT_KEEP || "10", 10);
const COMPACT_MODEL = process.env.COMPACT_MODEL || "gpt-4o-mini";

const SUMMARY_SYSTEM = `You are compacting an AI coding agent's conversation to save context space.
Analyze the conversation and produce a structured working-state summary.

Required sections:

## Task
What the user asked for. 1-2 sentences.

## Completed Work
Bullet list of actions taken. Include specific file paths, function names, commands run.

## Current State
Is the task done? Tests passing? Errors outstanding? What was the last thing done?

## Key Files
Each file created or modified, with 1-line description of its role/contents.

## Important Decisions
Any non-obvious choices made, resolved errors, or constraints discovered.

Rules:
- Be SPECIFIC: include file paths, line counts, error messages, test results
- Focus on WHAT EXISTS NOW, not the history of how it got there
- Do NOT narrate the conversation ("first the agent did X, then Y")
- Include everything the agent needs to continue working without re-reading files`;

export async function summarizeIfNeeded(
  messages: Message[],
  eventBus: IEventBus
): Promise<Message[]> {
  if (messages.length < SUMMARIZE_THRESHOLD) return messages;

  let splitPoint = messages.length - KEEP_RECENT;
  while (splitPoint > 0 && messages[splitPoint].role === "tool") {
    splitPoint--;
  }
  if (splitPoint <= 1) return messages;

  const toSummarize = messages.slice(0, splitPoint);
  const toKeep = messages.slice(splitPoint);

  console.log(`[compaction] ${messages.length} msgs → summarizing ${toSummarize.length}, keeping ${toKeep.length}`);

  eventBus.emit("compaction_start", {
    totalMessages: messages.length,
    summarizing: toSummarize.length,
    keeping: toKeep.length,
  });

  const formatted = toSummarize.map(formatForSummary).join("\n\n---\n\n");

  let summary: string;
  try {
    const provider = defaultManager.get();
    const result = await generateText({
      model: provider.chatModel(COMPACT_MODEL),
      system: SUMMARY_SYSTEM,
      messages: [
        {
          role: "user",
          content: `Compact the following agent conversation into a working-state summary:\n\n${formatted}`,
        },
      ],
    });
    summary = result.text;
  } catch (error) {
    console.error(`[compaction] Error: ${(error as Error).message}`);
    eventBus.emit("compaction_error", {
      error: (error as Error).message,
      message: "Failed to summarize. Keeping original messages.",
    });
    return messages;
  }

  console.log(`[compaction] done — ${summary.length} chars`);

  eventBus.emit("compaction_done", { summaryLength: summary.length, summary });

  return [
    {
      role: "user" as const,
      content: `[Previous work summary — refer to this for context]\n\n${summary}`,
    },
    {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "I have the context from the summary. I'll continue working on the task." }],
    },
    ...toKeep,
  ];
}

function formatForSummary(msg: Message): string {
  if (msg.role === "user") {
    return `USER: ${msg.content}`;
  }

  if (msg.role === "assistant") {
    const parts = Array.isArray(msg.content) ? msg.content : [msg.content];
    const formatted = parts
      .map((p) => {
        if (typeof p === "string") return p;
        if (p.type === "text") return p.text;
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

  if (msg.role === "tool") {
    const parts = Array.isArray(msg.content) ? msg.content : [msg.content];
    return parts
      .map((p) => {
        const output = p.output?.value || p.output || "";
        const text = typeof output === "string" ? output : JSON.stringify(output);
        const short = text.length > 500 ? text.slice(0, 500) + "..." : text;
        return `[${p.toolName} result]: ${short}`;
      })
      .join("\n");
  }

  return "";
}
