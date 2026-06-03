import type { AgentDefinition } from "../../core/types.js";

/** Pure data factory for subagent definitions (CC: AgentTool/loadAgentsDir). */
export function createAgentDefinition(def: AgentDefinition): AgentDefinition {
  if (def.tools && def.disallowedTools) {
    throw new Error(
      `Agent '${def.agentType}': specify either 'tools' (allow-list) or 'disallowedTools' (deny-list), not both.`,
    );
  }
  if (!def.agentType || !def.whenToUse || !def.systemPrompt) {
    throw new Error(
      `Agent definition missing required field (agentType / whenToUse / systemPrompt): ${def.agentType ?? "<unknown>"}`,
    );
  }
  return def;
}
