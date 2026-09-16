/**
 * Single dispatcher tool exposing all loaded skills. Mirrors the `task`
 * tool's "one tool, many subagent_types" pattern.
 *
 * The model calls `skill(skill_name=..., arguments=...)` and we either:
 *
 *   - inline:  expand the skill body ($ARGUMENTS / $1 / $name + !`shell` +
 *              @file), return `Launching skill: name` as the tool result,
 *              and inject the body as a meta user message (CC newMessages).
 *
 *   - fork:    spin up a fresh subagent run with the expanded body as the
 *              system prompt. Used for skills that need many tool calls —
 *              keeps the main agent's context lean.
 */

import { tool } from 'ai'
import { z } from 'zod'
import type {
  AgentDefinition,
  ToolContext,
  ToolDefinition,
} from '../../core/types.js'
import type { SkillDefinition } from '../../skills/types.js'
import { expandSkillBody, SkillExpansionError } from '../../skills/expand.js'
import { addInvokedSkill } from '../../skills/invoked-skills.js'
import { runSkillFork } from '../../skills/run-fork.js'

import { SKILL_TOOL_NAME } from '../../constants/tool_names.js'

export { SKILL_TOOL_NAME } from '../../constants/tool_names.js'

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
      'createSkillTool: at least one SkillDefinition required (none discovered)',
    )
  }

  const bySkill = new Map<string, SkillDefinition>()
  for (const s of skills) {
    if (bySkill.has(s.name)) {
      throw new Error(`Duplicate skill name '${s.name}'`)
    }
    bySkill.set(s.name, s)
  }
  const validSkills = [...bySkill.keys()]

  const description = `Invoke a reusable skill — a parameterized procedure the user (or this project) has defined for repeatable workflows.

Important:
- Available skills are listed in <system-reminder> messages in the conversation.
- When a listed skill's description matches this task, invoke it before starting that workflow. Skip skills that do not match.

Two execution modes:
- **inline** skills inject their expanded body as a follow-up message and return \`Launching skill: name\` as the tool result. Use them when you want to *remember* a procedure mid-thought (e.g. "code-review checklist", "PR-body template").
- **fork** skills run as a fresh subagent with the body as system prompt. Use them when the skill needs many tool calls and you don't want its scratch work in your context.

Arguments:
- \`skill_name\`: one of [${validSkills.join(', ')}]
- \`arguments\`: raw argument string (optional). Substituted into the skill body as \`$ARGUMENTS\`, \`$1\`, or \`$name\` depending on the skill's declared argument names.

Prefer skills over reinventing a procedure inline — they encode user/project conventions.`

  return {
    name: SKILL_TOOL_NAME,
    description,
    // Surface as a subagent-style card in the UI when the skill is `fork`.
    // For inline skills the card style is still useful — it groups the
    // launch line visually.
    isSubagent: true,
    isConcurrencySafe: () => false,
    outputSchema: z.object({
      success: z.boolean().optional(),
      skill_name: z.string().optional(),
      mode: z.string().optional(),
      text: z.string().optional(),
    }),
    mapToolResultToToolResultBlockParam(output, toolUseID) {
      const data = output as {
        skill_name?: string
        mode?: string
        text?: string
      }
      if (data.mode === 'fork') {
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: typeof data.text === 'string' ? data.text : '',
        }
      }
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: `Launching skill: ${data.skill_name ?? ''}`,
      }
    },
    create(cwd: string, context: ToolContext) {
      const { runAgent, eventBus, registry, toolEnablement } = context

      return tool({
        description,
        inputSchema: z.object({
          skill_name: z
            .enum(validSkills as [string, ...string[]])
            .describe(
              'Which skill to invoke. Must be a registered skill name.',
            ),
          arguments: z
            .string()
            .optional()
            .describe(
              'Raw argument string. Substituted into the skill body via $ARGUMENTS / $1 / $name. Pass an empty string if the skill takes none.',
            ),
        }),
        execute: async ({
          skill_name,
          arguments: rawArgs,
        }: {
          skill_name: string
          arguments?: string
        }) => {
          const skill = bySkill.get(skill_name)
          if (!skill) {
            return `Error: unknown skill '${skill_name}'. Valid: ${validSkills.join(', ')}`
          }

          // Body load + arg substitution + `!`/`@`/`${SKILL_DIR}` expansion
          // are all delegated to skills/expand.ts so this dispatcher and
          // the HTTP-facing /skills/:name/invoke endpoint produce
          // identical output byte-for-byte.
          let combined: string
          try {
            ;({ combined } = await expandSkillBody(skill, rawArgs ?? '', cwd))
          } catch (e) {
            if (e instanceof SkillExpansionError) return `Error: ${e.message}`
            throw e
          }

          // ── inline ── CC: short tool_result + body as meta newMessages.
          if (skill.context === 'inline') {
            if (context.session) {
              addInvokedSkill(
                context.session,
                skill_name,
                skill.filePath ?? skill.baseDir ?? skill_name,
                combined,
                null,
              )
            }
            return {
              data: { success: true, skill_name, mode: 'inline' as const },
              newMessages: [
                { role: 'user' as const, content: combined, isMeta: true },
              ],
            }
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
            return `Error: skill fork requires runAgent + registry in ToolContext`
          }

          try {
            const text = await runSkillFork({
              skill,
              combined,
              cwd,
              runAgent,
              registry,
              activeAgents: forkableAgents,
              eventBus,
              wire: context.wire,
              toolEnablement,
              provider: context.provider,
              models: context.models,
              compaction: context.compaction,
              sessionId: context.sessionId,
              permissionContext: context.permissionContext,
              execution: context.execution,
            })
            return {
              data: {
                text: typeof text === 'string' ? text : String(text),
                skill_name,
                mode: 'fork',
              },
            }
          } catch (e) {
            return `Error: ${(e as Error).message}`
          }
        },
      })
    },
  }
}
