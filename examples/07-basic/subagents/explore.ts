import { createSubagentDefinition } from "./base.js";
import { READ_ONLY_MODE, READ_ONLY_TOOLS } from "./prompt-fragments.js";
import { MUTATING_TOOLS } from "../tools/tool-names.js";

const EXPLORE_SYSTEM = `You are a read-only codebase exploration agent. Search, read, and report — never modify files or system state.

${READ_ONLY_MODE}

${READ_ONLY_TOOLS}

Strategy:
1. Fan out grep / list_dir calls in parallel to locate relevant code fast.
2. Read the most promising files (use offset/limit for large files).
3. Synthesize a structured response.

Response format:
- **Overview**: 1-2 sentences on what you found.
- **Key Files**: file paths with 1-line descriptions.
- **Relevant Code**: function names, patterns, line numbers.
- **Answer**: direct answer to the question.

Be specific (file paths + line numbers) so the parent can act without re-discovering the code. The parent only sees this final text.`;

export const definition = createSubagentDefinition({
  name: "explore",
  description:
    "Fast read-only subagent for exploring the codebase. Use when you need to find " +
    "files by pattern, search for keywords across many files, or answer 'how does X " +
    "work' / 'where is Y handled' — anything that would otherwise take more than ~3 " +
    "direct tool calls. Returns a structured summary with paths and line numbers. " +
    "Your context stays clean.",
  systemPrompt: EXPLORE_SYSTEM,
  // Inherit every parent tool except mutating ones. Sourced from the shared
  // MUTATING_TOOLS constant so renames / additions propagate automatically.
  disallowedTools: [...MUTATING_TOOLS],
  maxSteps: 20,
  label: "Explore subagent",
});
