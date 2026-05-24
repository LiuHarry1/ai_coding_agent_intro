import type { AnyTool, AppConfig, ToolDefinition } from "./types.js";

export type ToolEnablementSource = Pick<AppConfig, "disabledTools">;

/**
 * Determine if a tool should be deferred (excluded from the API `tools[]`
 * array until discovered via `tool_search`).
 *
 * Decision order (mirrors CC's `isDeferredTool`):
 *   1. `alwaysLoad === true`  → never deferred
 *   2. `isMcp === true`       → always deferred (workflow-specific)
 *   3. `shouldDefer === true`  → deferred
 *   4. default                → not deferred
 */
export function isDeferredTool(
  def: ToolDefinition,
  isMcp = false,
): boolean {
  if (def.alwaysLoad) return false;
  if (isMcp) return true;
  return def.shouldDefer === true;
}

/**
 * Resolve whether a tool is exposed to the model.
 * Precedence: disabledTools → ToolDefinition.enabled === false → default on.
 */
export function computeToolEnabled(
  toolName: string,
  definition: ToolDefinition | undefined,
  cfg: ToolEnablementSource | undefined
): boolean {
  if (cfg?.disabledTools?.includes(toolName)) return false;
  if (definition?.enabled === false) return false;

  return true;
}

export function filterToolsByEnablement(
  tools: Record<string, AnyTool>,
  registry: { get(name: string): ToolDefinition | undefined },
  cfg: ToolEnablementSource | undefined
): Record<string, AnyTool> {
  const out: Record<string, AnyTool> = {};
  for (const [name, t] of Object.entries(tools)) {
    if (computeToolEnabled(name, registry.get(name), cfg)) out[name] = t;
  }
  return out;
}
