import type { AnyTool } from '../types.js'

/**
 * Strip `execute` so the AI SDK emits tool-call blocks but does not run them.
 * The agent loop executes tools via `toolOrchestration` instead.
 */
export function stripToolExecute(
  tools: Record<string, AnyTool>,
): Record<string, AnyTool> {
  const apiTools: Record<string, AnyTool> = {}
  for (const [name, t] of Object.entries(tools)) {
    const { execute: _execute, ...rest } = t as AnyTool & {
      execute?: unknown
    }
    apiTools[name] = rest as AnyTool
  }
  return apiTools
}
