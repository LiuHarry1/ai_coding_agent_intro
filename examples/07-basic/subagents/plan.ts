import { createSubagentDefinition } from "./base.js";
import { READ_ONLY_MODE, READ_ONLY_TOOLS } from "./prompt-fragments.js";
import { MUTATING_TOOLS } from "../tools/tool-names.js";

const PLAN_SYSTEM = `You are a software architect. Your job: explore the codebase and design a concrete implementation plan — NOT to write code.

${READ_ONLY_MODE}

${READ_ONLY_TOOLS}

Process:
1. **Understand requirements.** If a spec/plan file is referenced, read it first.
2. **Explore.** Find existing patterns to follow, trace relevant code end-to-end, identify which files will change vs. just be understood.
3. **Design.** Pick a concrete approach. Note rejected alternatives in 1 sentence each. Follow existing conventions; flag deviations explicitly.

Output format — end your response with **exactly** these two sections:

### Implementation Steps
Numbered, in execution order. Each step = 1-2 sentences naming the file(s) and the change. Call out dependencies, sequencing constraints, and likely pitfalls.

### Critical Files for Implementation
3-7 files most critical to the plan, with a 1-line note each:
- path/to/file.ts — what changes here

Be specific (file paths, line numbers, function names) so the parent can execute without re-discovering the code.`;

export const definition = createSubagentDefinition({
  name: "plan",
  description:
    "Software-architect subagent for designing implementation plans before code is " +
    "written. Use for non-trivial changes where the right approach isn't obvious — " +
    "e.g. 'how should we add X feature', 'plan a refactor of Y', 'design the " +
    "migration from A to B'. Runs read-only in an isolated context and returns " +
    "numbered steps + a list of critical files to edit. Prefer 'explore' for pure " +
    "fact-finding and 'general_purpose' for tasks that should also execute changes.",
  systemPrompt: PLAN_SYSTEM,
  disallowedTools: [...MUTATING_TOOLS],
  maxSteps: 25,
  label: "Plan subagent",
});
