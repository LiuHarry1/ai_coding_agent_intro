import type { AgentDefinition, IToolRegistry } from "../core/types.js";
import { definition as exploreDef } from "./explore.js";
import { definition as planDef } from "./plan.js";
import { definition as generalPurposeDef } from "./general_purpose.js";
import { createTaskTool } from "../tools/task.js";
import { AGENT_TOOL_NAME } from "../tools/tool-names.js";
import { loadMarkdownConfigs } from "../core/markdown-config-loader.js";
import { mergeAgents } from "./from-files.js";

/**
 * Single source of truth for built-in subagents.
 *
 * After the single-Task architecture refactor these are *data*
 * (`AgentDefinition`) — not tool definitions. They are exposed to the
 * model as a directory inside the `task` tool's description, and dispatched
 * to via the `subagent_type` parameter.
 *
 * Add new entries here and the `task` tool's description, the schema's
 * `subagent_type` enum, and dispatch table all update automatically.
 */
export const BUILTIN_AGENTS: readonly AgentDefinition[] = [
  exploreDef,
  planDef,
  generalPurposeDef,
];

/**
 * Register the `task` tool with ONLY the built-in agents. Called once at
 * server boot so the registry has a working `task` tool before the first
 * request. Replaced per-request by `registerSubagents(registry, cwd)`,
 * which merges in markdown-defined agents from the user's filesystem.
 */
export function registerBuiltinSubagents(registry: IToolRegistry): void {
  registry.register(createTaskTool(BUILTIN_AGENTS));
}

/**
 * Discover markdown agents under `<cwd>/.agents/*.md` and
 * `~/.myagent/agents/*.md`, merge with built-ins (project > user > built-in),
 * and (re-)register the `task` tool with the combined directory.
 *
 * Called once per chat request from the router so a user editing an agent
 * .md file sees the change on the next message — no server restart needed.
 * Mirrors Claude Code's behavior: `getAgentDefinitionsWithOverrides` is
 * invoked from the agent loop, not at process boot.
 */
export async function registerSubagents(
  registry: IToolRegistry,
  cwd: string,
): Promise<{
  activeAgents: AgentDefinition[];
  errors: Array<{ filePath: string; error: string }>;
}> {
  const files = await loadMarkdownConfigs("agents", cwd);
  const { agents, errors } = mergeAgents(BUILTIN_AGENTS, files);
  registry.register(createTaskTool(agents));
  return { activeAgents: agents, errors };
}

/**
 * Names of tools that route to the SubagentCard / `isSubagent` UI path.
 *
 * In the new architecture this is exactly one name: `task`. Kept as a Set
 * (rather than a hardcoded constant downstream) so plugin code can layer
 * additional dispatcher tools later if needed.
 *
 * Lookup is via `def.isSubagent` so this stays a registry-driven
 * discovery — exactly the contract router.ts + stream-consumer.ts use.
 */
export function getSubagentNames(registry: IToolRegistry): Set<string> {
  const names = new Set<string>();
  for (const { name } of registry.list()) {
    if (registry.get(name)?.isSubagent) names.add(name);
  }
  // Belt-and-braces: the task tool name is always part of the set even
  // before registration, so test code that calls getSubagentNames on an
  // empty registry still produces correct UI tagging.
  names.add(AGENT_TOOL_NAME);
  return names;
}
