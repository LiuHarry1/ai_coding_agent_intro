import { tool } from "ai";
import { z } from "zod";
import { truncate, resolvePath } from "../tools/utils.js";
import { createBashTool } from "../tools/bash.js";
import { createReadFileTool } from "../tools/read_file.js";

const EXPLORE_SYSTEM = `You are an Explore subagent. Your job is to search and analyze a codebase, then return a concise structured summary.

You have read-only tools: read_file and bash (for ls, find, grep, wc, head, etc.).
You CANNOT modify any files — only read and search.

Workflow:
1. Start by understanding the request.
2. Use bash to list directories, find files, grep for patterns.
3. Use read_file to examine key files.
4. Synthesize your findings into a clear, structured summary.

Output format — reply with a structured summary including:
- **Overview**: 1-2 sentence description of what you found
- **Key Files**: important files with 1-line descriptions
- **Architecture**: how components connect (if applicable)
- **Relevant Code**: specific snippets, function names, patterns found
- **Answer**: direct answer to the user's question

Rules:
- Be thorough but concise — the parent agent only sees your final response.
- Include specific file paths and line numbers so the parent can act on them.
- Do NOT suggest changes or write code — just report what you find.
- Prefer multiple targeted searches over reading entire large files.`;

const MAX_EXPLORE_STEPS = 20;

/**
 * Create the explore tool that delegates to a subagent.
 *
 * Key insight: this calls the SAME runAgent function as the primary agent,
 * but with different tools, a different system prompt, and a fresh messages array.
 * That's all a subagent is — same loop, different config, isolated context.
 *
 * @param {string} cwd - Working directory
 * @param {Function} runAgent - The shared agent loop function
 * @param {Function} sendSSE - SSE emitter (will be prefixed for subagent events)
 */
export function createExploreTool(cwd, runAgent, sendSSE) {
  const utils = { truncate, resolvePath };

  const exploreTools = {
    read_file: createReadFileTool(cwd, utils),
    bash: createBashTool(cwd, utils),
  };

  return tool({
    description:
      "Explore and analyze the codebase using a subagent with its own isolated context. " +
      "Use this for tasks that require reading multiple files or searching across the project, " +
      "e.g. 'understand the project structure', 'find where authentication is implemented', " +
      "'list all API endpoints'. The subagent reads files and runs search commands, " +
      "then returns a structured summary. Your context stays clean.",
    inputSchema: z.object({
      task: z.string().describe(
        "What to explore or search for, e.g. 'analyze the project structure and tech stack' " +
        "or 'find all files related to user authentication'"
      ),
    }),
    execute: async ({ task }) => {
      const subSSE = (event, data) => sendSSE(`subagent_explore_${event}`, data);

      subSSE("step_start", { step: 0, task: task.slice(0, 80), label: "Explore subagent" });

      const result = await runAgent(task, {
        tools: exploreTools,
        systemPrompt: EXPLORE_SYSTEM,
        sendSSE: subSSE,
        messages: [],
        maxSteps: MAX_EXPLORE_STEPS,
      });

      return result || "(Explore subagent returned no result)";
    },
  });
}
