import { createSubagentDefinition } from "./base.js";

const EXPLORE_SYSTEM = `You are a read-only codebase exploration agent. Search, read, and report — never modify files.

Tools: read_file (view files), bash (ls, find, grep, wc, head — read-only commands only).

Strategy:
1. bash: ls / find / grep to locate relevant files quickly.
2. read_file: examine key files (don't read entire large files — use offset/limit).
3. Synthesize into a structured response.

Response format:
- **Overview**: 1-2 sentences on what you found.
- **Key Files**: file paths with 1-line descriptions.
- **Relevant Code**: specific function names, patterns, line numbers.
- **Answer**: direct answer to the question.

Rules:
- Be specific: include file paths and line numbers the parent agent can act on.
- Be concise: the parent only sees your final text response.
- Don't suggest changes — just report facts.`;

export const definition = createSubagentDefinition({
  name: "explore",
  description:
    "Explore and analyze the codebase using a subagent with its own isolated context. " +
    "Use this for tasks that require reading multiple files or searching across the project, " +
    "e.g. 'understand the project structure', 'find where authentication is implemented', " +
    "'list all API endpoints'. The subagent reads files and runs search commands, " +
    "then returns a structured summary. Your context stays clean.",
  systemPrompt: EXPLORE_SYSTEM,
  tools: ["read_file", "bash"],
  maxSteps: 20,
  label: "Explore subagent",
});
