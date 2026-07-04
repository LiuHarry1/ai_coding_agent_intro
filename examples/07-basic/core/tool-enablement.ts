import type { AnyTool, AppConfig, ToolDefinition } from './types.js'

export type ToolEnablementSource = Pick<AppConfig, 'disabledTools'>

/**
 * Resolve whether a tool is exposed to the model.
 * Precedence: disabledTools → ToolDefinition.enabled === false → default on.
 */
export function computeToolEnabled(
  toolName: string,
  definition: ToolDefinition | undefined,
  cfg: ToolEnablementSource | undefined,
): boolean {
  if (cfg?.disabledTools?.includes(toolName)) return false
  if (definition?.enabled === false) return false

  return true
}

export function filterToolsByEnablement(
  tools: Record<string, AnyTool>,
  registry: { get(name: string): ToolDefinition | undefined },
  cfg: ToolEnablementSource | undefined,
): Record<string, AnyTool> {
  const out: Record<string, AnyTool> = {}
  for (const [name, t] of Object.entries(tools)) {
    if (computeToolEnabled(name, registry.get(name), cfg)) out[name] = t
  }
  return out
}
