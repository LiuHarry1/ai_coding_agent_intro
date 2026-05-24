import { createAgentDefinition } from "./base.js";
import { AGENT_TOOL_NAME, INTERACTIVE_TOOLS } from "../tools/tool-names.js";

/** General-purpose subagent type identifier. */
export const GENERAL_PURPOSE_AGENT_TYPE = "general-purpose";

const GENERAL_PURPOSE_SYSTEM = `You are a general-purpose research and execution agent running in an isolated context. Complete the task fully — don't gold-plate, don't leave it half-done.

You inherit the parent's full toolset (read, search, shell, write, edit, plus MCP tools).

Guidelines:
- Fan out \`grep\` / \`glob\` calls in parallel when you don't know where something lives. Use \`read_file\` when you know the path.
- Start broad, then narrow. Try alternate naming conventions if the first search yields nothing.
- **NEVER create files unless absolutely necessary.** Prefer editing existing files.
- **NEVER proactively create documentation (\`*.md\`) or README files.** Only if the parent's prompt explicitly asks.
- Don't add features / abstractions / error handling beyond what was asked. Match the request — no more, no less.
- If you can't verify a change works (no test, can't run), say so explicitly in the final report rather than implying success.

Final report: what you did, key findings, files changed (with paths), and any commands the parent needs to run. The parent only sees this text — make it self-contained.`;

export const definition = createAgentDefinition({
  agentType: GENERAL_PURPOSE_AGENT_TYPE,
  whenToUse:
    'General-purpose subagent for open-ended research and multi-step tasks. ' +
    'Use when a task is broad enough that you are not confident you will ' +
    'resolve it in a few tool calls — e.g. user says "figure out how X works ' +
    'end-to-end", "investigate why Y happens", "set up Z across the project", ' +
    '"do a wide refactor across N files". Inherits the full toolset (including ' +
    'write/edit), runs in an isolated context, returns a concise final report. ' +
    'Prefer the more specialized Explore for pure read-only searches and ' +
    'Plan for architectural design without code changes.',
  description: "General-purpose research / execution",
  systemPrompt: GENERAL_PURPOSE_SYSTEM,
  // Block recursive task calls but otherwise inherit everything.
  disallowedTools: [...INTERACTIVE_TOOLS, AGENT_TOOL_NAME],
  maxSteps: 30,
  label: "Agent",
});
