import type { IToolRegistry, ToolDefinition } from "../core/types.js";
import { definition as exploreDef } from "./explore.js";
import { definition as planDef } from "./plan.js";
import { definition as generalPurposeDef } from "./general_purpose.js";

/**
 * Single source of truth for built-in subagents. Add new entries here and
 * everything downstream (registry-bootstrap, UI `isSubagent` tagging,
 * documentation) picks them up automatically.
 */
export const BUILTIN_SUBAGENTS: ToolDefinition[] = [
  exploreDef,
  planDef,
  generalPurposeDef,
];

/** Register every built-in subagent definition against the given registry. */
export function registerBuiltinSubagents(registry: IToolRegistry): void {
  for (const def of BUILTIN_SUBAGENTS) {
    registry.register(def);
  }
}

/**
 * Names of every registered subagent (built-in OR plugin-contributed) in
 * the given registry. Used by both:
 *   - runAgent (so it tags `tool_call` events with `isSubagent: true`)
 *   - sessionToUIMessages (so session-load preserves the flag for the UI)
 *
 * Lookup is via `def.isSubagent`, so any future subagent registered
 * outside `BUILTIN_SUBAGENTS` (e.g. from a plugin) is discovered for free.
 */
export function getSubagentNames(registry: IToolRegistry): Set<string> {
  const names = new Set<string>();
  for (const { name } of registry.list()) {
    if (registry.get(name)?.isSubagent) names.add(name);
  }
  return names;
}
