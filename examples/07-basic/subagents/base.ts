import type { AgentDefinition } from '../core/types.js'

/**
 * Pure data factory for subagent definitions. The single-Task architecture
 * means subagents are no longer wrapped as tools individually — instead
 * the `task` tool (see `tools/task.ts`) exposes them via a `subagent_type`
 * parameter, and uses the AgentDefinition entries to:
 *
 *   - Render the directory in its tool description (for model selection)
 *   - Dispatch to the right system prompt + tool subset on call
 *   - Apply per-agent maxSteps / model overrides
 *
 * This file used to return `ToolDefinition` objects that registered each
 * subagent as a sibling of `bash` / `read_file` / etc. That coupled
 * subagent count to the main-agent tool list size and made directory-style
 * comparison impossible. A single Agent tool with a dynamic agent list
 * avoids both issues.
 */
export function createAgentDefinition(def: AgentDefinition): AgentDefinition {
  if (def.tools && def.disallowedTools) {
    throw new Error(
      `Agent '${def.agentType}': specify either 'tools' (allow-list) or 'disallowedTools' (deny-list), not both.`,
    )
  }
  if (!def.agentType || !def.whenToUse || !def.systemPrompt) {
    throw new Error(
      `Agent definition missing required field (agentType / whenToUse / systemPrompt): ${def.agentType ?? '<unknown>'}`,
    )
  }
  return def
}
