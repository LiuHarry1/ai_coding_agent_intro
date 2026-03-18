import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { streamText } from "ai";
import { createProvider } from "../../../shared/provider.js";
import { createBashTool } from "../tools/bash.js";
import { truncate, resolvePath } from "../tools/utils.js";

const provider = createProvider();

const BASH_SUBAGENT_SYSTEM = `You are a Bash subagent. You only run shell commands.

- You have exactly one tool: bash. Use it to run the user's task.
- Run only the necessary command(s). Prefer one command with && if multiple steps.
- Return a brief conclusion after running (e.g. "Done. Listed 5 files." or "Command failed: ...").
- Do not explain at length — the parent agent only needs the outcome and key output.`;

const MAX_SUBAGENT_STEPS = 20;
const RESULT_MAX_CHARS = 2500;
const CACHE_DIR = ".agent-cache";

/**
 * Run bash in an isolated subagent context. Returns a string for the main agent:
 * either the full output (if short) or a summary + path to full output file.
 */
export async function runBashSubagent(task, cwd, sendSSE = () => {}) {
  const utils = { truncate, resolvePath };
  const bashTool = createBashTool(cwd, utils);

  const messages = [
    {
      role: "user",
      content: `Task: ${task}\n\nRun the necessary shell command(s) using the bash tool. Then reply briefly with the outcome.`,
    },
  ];

  const allBashOutputs = [];

  for (let step = 0; step < MAX_SUBAGENT_STEPS; step++) {
    sendSSE("subagent_bash", { step, task: task.slice(0, 80), label: "Bash subagent" });

    const stream = streamText({
      model: provider.chatModel("gpt-5.2"),
      system: BASH_SUBAGENT_SYSTEM,
      messages,
      tools: { bash: bashTool },
    });

    const toolCalls = [];
    const toolResults = [];
    let textAccum = "";

    for await (const event of stream.fullStream) {
      switch (event.type) {
        case "text-delta":
          if (event.textDelta) textAccum += event.textDelta;
          break;
        case "tool-call":
          toolCalls.push({
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: event.input ?? event.args,
          });
          if (event.toolName === "bash" && event.input?.command) {
            sendSSE("subagent_bash_tool_call", { command: event.input.command });
          }
          break;
        case "tool-result": {
          const raw = event.output ?? event.result ?? "";
          const result = typeof raw === "string" ? raw : JSON.stringify(raw);
          toolResults.push({ toolCallId: event.toolCallId, toolName: event.toolName, result });
          if (event.toolName === "bash") {
            allBashOutputs.push(result);
            const preview = result.length > 1500 ? result.slice(0, 1500) + "\n\n... (truncated)" : result;
            sendSSE("subagent_bash_tool_result", { result: preview, length: result.length });
          }
          break;
        }
        default:
          break;
      }
    }

    const assistantContent = [];
    if (textAccum) assistantContent.push({ type: "text", text: textAccum });
    for (const tc of toolCalls) {
      assistantContent.push({
        type: "tool-call",
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        input: tc.input,
      });
    }
    messages.push({ role: "assistant", content: assistantContent });

    if (toolCalls.length === 0) {
      const fullOutput = allBashOutputs.join("\n\n---\n\n");
      return formatResultForMainAgent(fullOutput, textAccum.trim(), cwd);
    }

    for (const tr of toolResults) {
      messages.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: tr.toolCallId,
            toolName: tr.toolName,
            output: { type: "text", value: tr.result },
          },
        ],
      });
    }
  }

  const fullOutput = allBashOutputs.join("\n\n---\n\n");
  return formatResultForMainAgent(fullOutput, "(subagent max steps reached)", cwd);
}

function formatResultForMainAgent(fullOutput, conclusion, cwd) {
  const trimmed = fullOutput.trim();
  if (!trimmed) {
    return `Bash subagent: ${conclusion || "No command output."}`;
  }
  if (trimmed.length <= RESULT_MAX_CHARS) {
    return `Bash subagent:\n${conclusion ? conclusion + "\n\n" : ""}Output:\n${trimmed}`;
  }
  const cacheDir = path.resolve(cwd, CACHE_DIR);
  fs.mkdirSync(cacheDir, { recursive: true });
  const id = randomUUID().slice(0, 8);
  const filePath = path.join(CACHE_DIR, `bash-${id}.txt`);
  const absPath = path.join(cacheDir, `bash-${id}.txt`);
  fs.writeFileSync(absPath, trimmed, "utf-8");
  const preview = trimmed.slice(0, 600) + "\n\n... [truncated] ...";
  return `Bash subagent:\n${conclusion || "Done."}\n\nOutput (long): first 600 chars below; full output saved to ${filePath} — use read_file("${filePath}") if you need the rest.\n\n${preview}`;
}
