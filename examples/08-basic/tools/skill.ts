/**
 * Single dispatcher tool exposing all loaded skills. Mirrors the `task`
 * tool's "one tool, many subagent_types" pattern from CC.
 *
 * The model calls `skill(skill_name=..., arguments=...)` and we either:
 *
 *   - inline:  expand the skill body ($ARGUMENTS / $1 / $name + !`shell` +
 *              @file) and return it as the tool result. The model reads it
 *              on the next turn like a "remembered" procedure.
 *
 *   - fork:    spin up a fresh subagent run with the expanded body as the
 *              system prompt. Used for skills that need many tool calls —
 *              keeps the main agent's context lean.
 */

import { tool } from "ai";
import { z } from "zod";
import type {
  AgentDefinition,
  AnyTool,
  ToolContext,
  ToolDefinition,
} from "../core/types.js";
import type { SkillDefinition } from "../skills/types.js";
import { expandSkillBody, SkillExpansionError } from "../skills/expand.js";
import { AGENT_TOOL_NAME } from "./tool-names.js";

export const SKILL_TOOL_NAME = "skill";

export function createSkillTool(
  skills: readonly SkillDefinition[],
  /**
   * Agents available for `context: fork` skills. The tool resolves
   * `skill.agent` (defaults to `general_purpose`) against this list to
   * find the right system-prompt scaffolding + tool subset. Pass the
   * same merged list you handed to `createTaskTool`.
   */
  forkableAgents: readonly AgentDefinition[],
): ToolDefinition {
  if (skills.length === 0) {
    throw new Error(
      "createSkillTool: at least one SkillDefinition required (none discovered)",
    );
  }

  const bySkill = new Map<string, SkillDefinition>();
  for (const s of skills) {
    if (bySkill.has(s.name)) {
      throw new Error(`Duplicate skill name '${s.name}'`);
    }
    bySkill.set(s.name, s);
  }
  const validSkills = [...bySkill.keys()];

  const byAgent = new Map<string, AgentDefinition>();
  for (const a of forkableAgents) byAgent.set(a.agentType, a);

  const directory = skills
    .map((s) => `- ${s.name} (${s.context}): ${s.description}`)
    .join("\n");

  const description = `Invoke a reusable skill — a parameterized procedure the user (or this project) has defined for repeatable workflows.

Available skills:
${directory}

Two execution modes:
- **inline** skills return their expanded body as the tool result. Use them when you want to *remember* a procedure mid-thought (e.g. "code-review checklist", "PR-body template").
- **fork** skills run as a fresh subagent with the body as system prompt. Use them when the skill needs many tool calls and you don't want its scratch work in your context.

Required arguments:
- \`skill_name\`: one of [${validSkills.join(", ")}]
- \`arguments\`: raw argument string (optional). Substituted into the skill body as \`$ARGUMENTS\`, \`$1\`, or \`$name\` depending on the skill's declared argument names.

Prefer skills over reinventing a procedure inline — they encode user/project conventions.`;

  return {
    name: SKILL_TOOL_NAME,
    description,
    // Surface as a subagent-style card in the UI when the skill is `fork`.
    // For inline skills the card style is still useful — it groups the
    // expanded body visually.
    isSubagent: true,
    create(cwd: string, context: ToolContext) {
      const { runAgent, eventBus, registry, toolEnablement } = context;

      return tool({
        description,
        inputSchema: z.object({
          skill_name: z
            .enum(validSkills as [string, ...string[]])
            .describe("Which skill to invoke. Must be a registered skill name."),
          arguments: z
            .string()
            .optional()
            .describe(
              "Raw argument string. Substituted into the skill body via $ARGUMENTS / $1 / $name. Pass an empty string if the skill takes none.",
            ),
        }),
        execute: async ({
          skill_name,
          arguments: rawArgs,
        }: {
          skill_name: string;
          arguments?: string;
        }) => {
          const skill = bySkill.get(skill_name);
          if (!skill) {
            return `Error: unknown skill '${skill_name}'. Valid: ${validSkills.join(", ")}`;
          }

          // Body load + arg substitution + `!`/`@`/`${SKILL_DIR}` expansion
          // are all delegated to skills/expand.ts so this dispatcher and
          // the HTTP-facing /skills/:name/invoke endpoint produce
          // identical output byte-for-byte.
          let combined: string;
          try {
            ({ combined } = await expandSkillBody(skill, rawArgs ?? "", cwd));
          } catch (e) {
            if (e instanceof SkillExpansionError) return `Error: ${e.message}`;
            throw e;
          }

          // ── inline ── return the expanded body as the tool result.
          if (skill.context === "inline") {
            return combined;
          }

          // ── fork ── dispatch as a subagent using the requested agent
          // type's system prompt + tool subset, but with the SKILL body
          // injected as the user prompt.
          //
          // This is the same machinery as `task`, condensed: we look up
          // the agent definition, build its tool surface (honoring
          // tools/disallowedTools), and call runAgent with the skill's
          // expanded body as the user message.
          if (!runAgent || !registry) {
            return `Error: skill fork requires runAgent + registry in ToolContext`;
          }
          const targetAgent = byAgent.get(skill.agent ?? "general_purpose");
          if (!targetAgent) {
            return `Error: skill '${skill_name}' fork target '${skill.agent ?? "general_purpose"}' not found. Available: ${[...byAgent.keys()].join(", ")}`;
          }

          const subBus = eventBus.scoped(`skill_${skill_name}`);
          subBus.emit("step_start", {
            step: 0,
            task: skill_name,
            label: `Skill: ${skill_name}`,
          });

          const subContext: ToolContext = {
            eventBus: subBus,
            registry,
            runAgent,
            toolEnablement,
          };

          let subTools: Record<string, AnyTool>;
          if (targetAgent.tools) {
            subTools = registry.createAll(cwd, subContext, targetAgent.tools);
          } else {
            subTools = registry.createAll(cwd, subContext);
            const denied = new Set(targetAgent.disallowedTools ?? []);
            denied.add(AGENT_TOOL_NAME);
            denied.add(SKILL_TOOL_NAME);
            for (const n of denied) delete subTools[n];
          }
          delete subTools[AGENT_TOOL_NAME];
          delete subTools[SKILL_TOOL_NAME];

          const result = await runAgent(combined, {
            tools: subTools,
            systemPrompt: targetAgent.systemPrompt,
            eventBus: subBus,
            messages: [],
            maxSteps: targetAgent.maxSteps ?? 20,
            model: targetAgent.model,
          });

          return result || `(skill ${skill_name} returned no result)`;
        },
      });
    },
  };
}
