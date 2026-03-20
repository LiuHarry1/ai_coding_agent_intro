import { generateText } from "ai";
import { createProvider } from "../../shared/provider.js";

const provider = createProvider();

const SUMMARIZE_THRESHOLD = parseInt(process.env.COMPACT_THRESHOLD || "40", 10);
const KEEP_RECENT = parseInt(process.env.COMPACT_KEEP || "10", 10);

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

/**
 * If messages exceed the threshold, compress older messages into a
 * structured working-state summary. Returns the (possibly shortened)
 * messages array.  Mutates nothing — returns a new array.
 */
export async function summarizeIfNeeded(messages, sendSSE = () => {}) {
  if (messages.length < SUMMARIZE_THRESHOLD) return messages;

  // Find a safe split point: toKeep must NOT start with a "tool" message,
  // because tool-results are only valid after the assistant's tool-call.
  let splitPoint = messages.length - KEEP_RECENT;
  while (splitPoint > 0 && messages[splitPoint].role === "tool") {
    splitPoint--;
  }
  if (splitPoint <= 1) return messages;

  const toSummarize = messages.slice(0, splitPoint);
  const toKeep = messages.slice(splitPoint);

  console.log(`\n${"═".repeat(60)}`);
  console.log(`[compaction] Triggered: ${messages.length} messages (threshold: ${SUMMARIZE_THRESHOLD})`);
  console.log(`[compaction] Summarizing ${toSummarize.length} messages, keeping ${toKeep.length}`);
  console.log(`${"─".repeat(60)}`);

  sendSSE("compaction_start", {
    totalMessages: messages.length,
    summarizing: toSummarize.length,
    keeping: toKeep.length,
  });

  const formatted = toSummarize.map(formatForSummary).join("\n\n---\n\n");

  console.log(`[compaction] Input to summarizer (${formatted.length} chars):`);
  console.log(`${"─".repeat(40)}`);
  const preview = formatted.length > 2000
    ? formatted.slice(0, 1000) + `\n\n... (${formatted.length - 2000} chars omitted) ...\n\n` + formatted.slice(-1000)
    : formatted;
  console.log(preview);
  console.log(`${"─".repeat(40)}`);

  let summary;
  try {
    const result = await generateText({
      model: provider.chatModel("gpt-4o-mini"),
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
    console.error(`[compaction] Error during summarization: ${error.message}`);
    console.error(`[compaction] Stack: ${error.stack}`);
    sendSSE("compaction_error", { 
      error: error.message,
      message: "Failed to summarize conversation. Keeping original messages."
    });
    // Return original messages if summarization fails
    return messages;
  }

  console.log(`[compaction] Summary output (${summary.length} chars):`);
  console.log(`${"─".repeat(40)}`);
  console.log(summary);
  console.log(`${"═".repeat(60)}\n`);

  sendSSE("compaction_done", { summaryLength: summary.length, summary });

  return [
    {
      role: "user",
      content: `[Previous work summary — refer to this for context]\n\n${summary}`,
    },
    {
      role: "assistant",
      content:
        "I have the context from the summary. I'll continue working on the task.",
    },
    ...toKeep,
  ];
}

function formatForSummary(msg) {
  if (msg.role === "user") {
    const text =
      typeof msg.content === "string"
        ? msg.content
        : JSON.stringify(msg.content);
    return `USER: ${text}`;
  }

  if (msg.role === "assistant") {
    const parts = Array.isArray(msg.content) ? msg.content : [msg.content];
    const formatted = parts
      .map((p) => {
        if (typeof p === "string") return p;
        if (p.type === "text") return p.text;
        if (p.type === "tool-call") {
          const args = JSON.stringify(p.input || {});
          const shortArgs =
            args.length > 300 ? args.slice(0, 300) + "..." : args;
          return `[Called ${p.toolName}(${shortArgs})]`;
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
        const text =
          typeof output === "string" ? output : JSON.stringify(output);
        const short =
          text.length > 500 ? text.slice(0, 500) + "..." : text;
        return `[${p.toolName} result]: ${short}`;
      })
      .join("\n");
  }

  return "";
}
