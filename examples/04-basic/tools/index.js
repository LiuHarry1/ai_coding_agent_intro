import { truncate, resolvePath } from "./utils.js";
import { createBashTool } from "./bash.js";
import { createReadFileTool } from "./read_file.js";
import { createWriteFileTool } from "./write_file.js";
import { createEditFileTool } from "./edit_file.js";
import { createExploreTool } from "../subagents/explore.js";

/**
 * Create primary agent tools.
 *
 * Direct tools: bash, read_file, write_file, edit_file
 * Subagent tool: explore (runs in isolated context via runAgent)
 *
 * @param {string} cwd - Working directory
 * @param {Function} runAgent - The shared agent loop (passed to explore subagent)
 * @param {Function} sendSSE - SSE emitter (passed to explore subagent for streaming)
 */
export function createTools(cwd, runAgent, sendSSE) {
  const utils = { truncate, resolvePath };

  return {
    bash: createBashTool(cwd, utils),
    read_file: createReadFileTool(cwd, utils),
    write_file: createWriteFileTool(cwd, utils),
    edit_file: createEditFileTool(cwd, utils),
    explore: createExploreTool(cwd, runAgent, sendSSE),
  };
}
