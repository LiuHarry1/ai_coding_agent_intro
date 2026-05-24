import { tool } from "ai";
import { z } from "zod";
import type {
  AgentDefinition,
  AnyTool,
  ToolContext,
  ToolDefinition,
} from "../core/types.js";
import { AGENT_TOOL_NAME } from "./tool-names.js";
import { EXPLORE_AGENT_TYPE } from "../subagents/explore.js";
import { PLAN_AGENT_TYPE } from "../subagents/plan.js";
import { loadProjectRules } from "../core/rules-loader.js";

/**
 * Single tool that dispatches to all built-in subagents via a
 * `subagent_type` parameter.
 *
 * Why a single dispatcher instead of one tool per subagent (the previous
 * design)?
 *
 *   1. The directory of agents is rendered into ONE tool description, so
 *      the model sees them side-by-side and can pick the best fit instead
 *      of making the call decision N times in isolation.
 *   2. Adding a new subagent never enlarges the main agent's tool count
 *      — a flat list of ~7 tools stays ~7 tools regardless of how many
 *      specialist agents we register.
 *   3. The argument schema and "when to use" guidance is uniform, which
 *      makes prompt-engineering for delegation a single-file concern
 *      (this file's static description block).
 *
 * Anti-recursion: subagents must declare `task` in their `disallowedTools`
 * list (see `subagents/explore.ts` etc.). We also defensively delete the
 * `task` entry from `subTools` below so a misconfigured agent definition
 * cannot spawn nested subagents.
 */
export function createTaskTool(agents: readonly AgentDefinition[]): ToolDefinition {
  if (agents.length === 0) {
    throw new Error("createTaskTool: at least one AgentDefinition required");
  }

  // Index the agents by agentType for O(1) dispatch and to detect duplicates.
  const byType = new Map<string, AgentDefinition>();
  for (const a of agents) {
    if (byType.has(a.agentType)) {
      throw new Error(`Duplicate agentType '${a.agentType}' in BUILTIN_AGENTS`);
    }
    byType.set(a.agentType, a);
  }
  const validTypes = [...byType.keys()];

  // Build the static portion of the description ONCE at registration time.
  // Each entry surfaces the agent's `whenToUse` paragraph plus its tool
  // surface so the model can judge capabilities at a glance.
  const directory = agents
    .map((a) => {
      const toolsDesc = a.disallowedTools?.length
        ? `All tools except ${a.disallowedTools.join(", ")}`
        : a.tools?.length
          ? a.tools.join(", ")
          : "All tools";
      return `- ${a.agentType}: ${a.whenToUse} (Tools: ${toolsDesc})`;
    })
    .join("\n");

  const description = `Launch a new agent to handle complex, multi-step tasks autonomously.

The ${AGENT_TOOL_NAME} tool launches specialized agents (subprocesses) that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.

Available agent types:
${directory}

When using the ${AGENT_TOOL_NAME} tool, specify a \`subagent_type\` parameter to select which agent type to use.

When NOT to use the ${AGENT_TOOL_NAME} tool:
- If you want to read a specific file path, use \`read_file\` or \`glob\` instead of the ${AGENT_TOOL_NAME} tool, to find the match more quickly
- If you are searching for a specific class definition like "class Foo", use \`glob\` instead, to find the match more quickly
- If you are searching for code within a specific file or set of 2-3 files, use \`read_file\` instead of the ${AGENT_TOOL_NAME} tool, to find the match more quickly
- Other tasks that are not related to the agent descriptions above

Usage notes:
- Always include a short \`description\` (3-5 words) summarizing what the agent will do.
- You can issue several \`${AGENT_TOOL_NAME}\` calls in one response to dispatch independent agents in parallel. If the user says "in parallel", you MUST send a single message with multiple ${AGENT_TOOL_NAME} tool use content blocks.
- Each invocation starts fresh — the subagent does NOT see your prior conversation. The \`prompt\` must be self-contained.
- The subagent returns a single final report. The result is NOT visible to the user — summarize the relevant parts in your own reply.
- The subagent's outputs should generally be trusted. Don't re-run the same searches yourself.
- Clearly tell the subagent whether you expect it to write code or just research, since it is not aware of the user's intent.
- If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.

Writing the prompt — brief the subagent like a smart colleague who just walked into the room. They have not seen this conversation, do not know what you've tried, do not understand why this task matters.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- Be specific about scope and the form of answer you want ("report in under 200 words", "list of file:line citations").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.
- Never delegate understanding. Don't write "based on your findings, fix the bug" — that pushes synthesis onto the subagent. Write prompts that prove you understood: file paths, line numbers, what specifically to change.

Terse command-style prompts produce shallow, generic work.

Examples:

<example_agent_descriptions>
"${EXPLORE_AGENT_TYPE}": use this agent for exploring and understanding codebases
"${PLAN_AGENT_TYPE}": use this agent to design implementation plans before writing code
</example_agent_descriptions>

<example>
user: "Where is the SSE transport implemented and how does it stream tool events?"
<commentary>
This is a broad "how does X work" question across multiple files. Use the ${EXPLORE_AGENT_TYPE} agent since it will require searching many files.
</commentary>
assistant: Uses the ${AGENT_TOOL_NAME} tool to launch the ${EXPLORE_AGENT_TYPE} agent with a detailed prompt explaining what to find.
</example>

<example>
user: "Refactor the agent loop to support cancellation."
<commentary>
Non-trivial architecture change. Use the ${PLAN_AGENT_TYPE} agent to explore and design first, then implement.
</commentary>
assistant: Uses the ${AGENT_TOOL_NAME} tool to launch the ${PLAN_AGENT_TYPE} agent
</example>`;

  return {
    name: AGENT_TOOL_NAME,
    description,
    isSubagent: true,
    create(cwd: string, context: ToolContext) {
      const { runAgent, eventBus, registry, toolEnablement } = context;

      return tool({
        description,
        inputSchema: z.object({
          subagent_type: z
            .enum(validTypes as [string, ...string[]])
            .describe(
              "Which subagent to dispatch to. Must be one of the registered agent types.",
            ),
          description: z
            .string()
            .min(1)
            .describe("Short 3-5 word title for the task, shown in the UI."),
          prompt: z
            .string()
            .min(1)
            .describe(
              "Self-contained, detailed task description. The subagent does NOT see prior conversation, so include all needed context, file paths, and what to return.",
            ),
        }),
        execute: async ({
          subagent_type,
          description: shortDesc,
          prompt,
        }: {
          subagent_type: string;
          description: string;
          prompt: string;
        }) => {
          const def = byType.get(subagent_type);
          if (!def) {
            return `Error: unknown subagent_type '${subagent_type}'. Valid: ${validTypes.join(", ")}`;
          }
          if (!runAgent || !registry) {
            return `Error: task tool requires runAgent + registry in ToolContext`;
          }

          // Scope event bus by the subagent_type so the front-end's
          // SubagentCard groups nested tool events correctly and applies
          // the per-type styling (purple/amber/slate).
          const subBus = eventBus.scoped(`subagent_${subagent_type}`);

          subBus.emit("step_start", {
            step: 0,
            task: shortDesc.slice(0, 80),
            label: def.label || subagent_type,
          });

          // Build the subagent's tool surface. The allow/deny lists from
          // the AgentDefinition are honored here, plus we always strip the
          // task tool itself to prevent recursion regardless of config.
          const subContext: ToolContext = {
            eventBus: subBus,
            registry,
            runAgent,
            toolEnablement,
          };

          let subTools: Record<string, AnyTool>;
          if (def.tools) {
            subTools = registry.createAll(cwd, subContext, def.tools);
          } else {
            subTools = registry.createAll(cwd, subContext);
            const denied = new Set(def.disallowedTools ?? []);
            denied.add(AGENT_TOOL_NAME);
            for (const n of denied) delete subTools[n];
          }
          // Defense in depth: even with neither list set, the parent's
          // task tool itself must never be in the subagent's toolset.
          delete subTools[AGENT_TOOL_NAME];

          // Inject project rules unless the subagent opted out. Read-only
          // exploration agents (Explore) skip this — rules carry
          // commit/PR/lint guidance they won't act on, and parent already
          // interprets the result with full context. General-purpose /
          // plan agents do receive rules so commits and architectural
          // designs respect project conventions.
          const projectRules = def.omitProjectRules ? "" : loadProjectRules(cwd);
          const subSystemPrompt = projectRules
            ? `${def.systemPrompt}\n\n<project_rules>\nThe following rules were auto-loaded from the project (AGENTS.md / CLAUDE.md / .cursor/rules/*.md / .cursorrules). They take precedence over all other sections when there is a conflict.\n\n${projectRules}\n</project_rules>`
            : def.systemPrompt;

          const result = await runAgent(prompt, {
            tools: subTools,
            systemPrompt: subSystemPrompt,
            eventBus: subBus,
            messages: [],
            maxSteps: def.maxSteps ?? 20,
            model: def.model,
          });

          return result || `(${subagent_type} subagent returned no result)`;
        },
      });
    },
  };
}
