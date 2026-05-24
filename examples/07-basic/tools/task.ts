import { tool } from "ai";
import { z } from "zod";
import type {
  AgentDefinition,
  AnyTool,
  ToolContext,
  ToolDefinition,
} from "../core/types.js";
import { TASK_TOOL_NAME } from "./tool-names.js";

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
  // Each entry surfaces the agent's `whenToUse` paragraph so the model has
  // the same selection signal it would have if these were N separate tools.
  // We deliberately do NOT print the disallowedTools list here — the
  // whenToUse text already conveys the relevant capability ("read-only",
  // "full toolset", etc.), and dumping every denied tool name was noise
  // that didn't change selection behavior.
  const directory = agents
    .map((a) => `- ${a.agentType}: ${a.whenToUse}`)
    .join("\n");

  const description = `Launch a new subagent to handle complex, multi-step tasks autonomously.

The task tool launches specialized agents that handle work in their own isolated context. Each agent type has specific capabilities — pick the one whose description matches the task.

Available subagent types:
${directory}

When using the task tool, specify a \`subagent_type\` parameter to select which agent runs.

When NOT to use the task tool:
- You already know the file(s) you need → use \`read_file\` directly.
- A specific symbol you can grep in one shot → use grep / bash directly.
- The task needs interactive back-and-forth — subagents run autonomously to completion.

No-duplication rule: \`plan\` already explores as part of its process. Don't run \`explore\` and \`plan\` in parallel on the same topic. If you need facts before planning, run \`explore\` first, then pass its report into \`plan\`'s prompt.

Usage notes:
- Always include a short \`description\` (3-5 words) summarizing what the agent will do.
- You can issue several \`task\` calls in one response to dispatch independent subagents in parallel. If the user says "in parallel", you MUST do this.
- Each invocation starts fresh — the subagent does NOT see your prior conversation. The \`prompt\` must be self-contained.
- The subagent returns a single final report. The result is NOT visible to the user — summarize the relevant parts in your own reply.
- The subagent's outputs should generally be trusted. Don't re-run the same searches yourself.
- Clearly tell the subagent whether you expect it to write code or just research. \`general_purpose\` has write access; be explicit.

Writing the prompt — brief the subagent like a smart colleague who just walked into the room. They have not seen this conversation, do not know what you've tried, do not know why this matters.
- Explain the goal and why it matters in 1-2 sentences.
- Include what you've already learned or ruled out.
- Be specific about scope and the form of answer you want ("report in under 200 words", "list of file:line citations").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.
- Never delegate understanding. Don't write "based on your findings, fix the bug" — that pushes synthesis onto the subagent. Write prompts that prove you understood: file paths, line numbers, what specifically to change.

Required arguments:
- \`subagent_type\`: one of [${validTypes.join(", ")}]
- \`description\`: 3-5 word title shown in the activity log.
- \`prompt\`: self-contained task description (see writing-the-prompt rules above).

Examples:

<example>
User: "Where is the SSE transport implemented and how does it stream tool events?"
→ Broad "how does X work" across multiple files. Call \`task\` with \`subagent_type: "explore"\`.
</example>

<example>
User: "Add retry logic to core/llm/strategies/openai.ts."
→ You know the file. Read it directly and edit. No \`task\` call needed.
</example>

<example>
User: "Refactor the agent loop to support cancellation."
→ Non-trivial architecture. Call \`task\` with \`subagent_type: "plan"\`; it explores and designs. Then implement its plan.
</example>`;

  return {
    name: TASK_TOOL_NAME,
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
            denied.add(TASK_TOOL_NAME);
            for (const n of denied) delete subTools[n];
          }
          // Defense in depth: even with neither list set, the parent's
          // task tool itself must never be in the subagent's toolset.
          delete subTools[TASK_TOOL_NAME];

          const result = await runAgent(prompt, {
            tools: subTools,
            systemPrompt: def.systemPrompt,
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
