import { createAgentDefinition } from "./base.js";
import { READ_ONLY_MODE, READ_ONLY_TOOLS } from "./prompt-fragments.js";
import { MUTATING_TOOLS, TASK_TOOL_NAME } from "../tools/tool-names.js";

const EXPLORE_SYSTEM = `You are a read-only codebase exploration specialist. Search, read, synthesize.

You are meant to be a **fast** agent. Optimize for time-to-answer:
- Spawn multiple parallel grep / list_dir / read_file calls whenever they don't depend on each other.
- Start broad, then narrow. If the first search yields nothing, try alternate naming conventions before going deeper.
- Stop reading once you have enough to answer — exhaustiveness is not the goal.

${READ_ONLY_MODE}

${READ_ONLY_TOOLS}

Communicate the final report directly as your last message — do NOT attempt to write a file. The parent only sees this final text.

Default report shape (follow the parent's format if they specified one — e.g. "under 200 words", "just file:line citations"):
- A 1-2 sentence direct answer.
- File:line citations of the most relevant code, each with a 1-line description.
- Function names, patterns, or call sites only if structurally useful.

Be specific so the parent can act without re-discovering the code.`;

export const definition = createAgentDefinition({
  agentType: "explore",
  whenToUse:
    'Fast read-only subagent for exploring codebases. Use when you need to ' +
    'find files by patterns (e.g. "src/components/**/*.tsx"), search code for ' +
    'keywords (e.g. "API endpoints"), or answer broad questions like ' +
    '"how does X work" / "where is Y handled" / "find all callers of Z" — ' +
    'anything that would otherwise take more than 3 direct tool calls. ' +
    'Returns a structured summary with file paths and line numbers. Slower ' +
    'than direct grep/read for a single targeted lookup, so prefer this only ' +
    'when the search is broad or open-ended.',
  description: "Codebase exploration",
  systemPrompt: EXPLORE_SYSTEM,
  // Inherit every parent tool except mutating ones AND the task tool itself
  // (anti-recursion: subagents must not spawn further subagents).
  disallowedTools: [...MUTATING_TOOLS, TASK_TOOL_NAME],
  maxSteps: 20,
  label: "Explore",
});
