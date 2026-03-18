import { tool } from "ai";
import { z } from "zod";
import { truncate, resolvePath } from "./utils.js";
import { createReadFileTool } from "./read_file.js";
import { createWriteFileTool } from "./write_file.js";
import { createEditFileTool } from "./edit_file.js";
import { runBashSubagent } from "../subagents/bash.js";

/**
 * Create main-agent tools. Includes run_bash_task (Bash subagent) by default.
 *
 * @param {string} cwd - Working directory
 * @param {((event: string, data: object) => void)} [sendSSE] - Optional; for streaming subagent command/output to client
 */
export function createTools(cwd, sendSSE = () => {}) {
  const utils = { truncate, resolvePath };

  return {
    read_file: createReadFileTool(cwd, utils),
    write_file: createWriteFileTool(cwd, utils),
    edit_file: createEditFileTool(cwd, utils),
    run_bash_task: tool({
      description:
        "Run shell commands via the Bash subagent. Use this for: listing files (ls), running scripts (npm test, node x.js), " +
        "git commands, or any terminal task. The subagent runs in an isolated context and returns a concise result; " +
        "long output is saved to .agent-cache/ and you can read_file it if needed.",
      inputSchema: z.object({
        task: z.string().describe("What to do in the shell, e.g. 'list files in current directory' or 'run npm test'"),
      }),
      execute: async ({ task }) => runBashSubagent(task, cwd, sendSSE),
    }),
  };
}
