import type { IToolRegistry } from './types.js'

export type ConcurrencyPolicyFn = (toolName: string, input: unknown) => boolean

/**
 * Build a runtime concurrency policy from registered tool definitions.
 * Tools without `isConcurrencySafe` default to serial execution (CC default).
 */
export function buildConcurrencyPolicy(
  registry: IToolRegistry,
  toolNames: readonly string[],
): ConcurrencyPolicyFn {
  void toolNames
  return (toolName: string, input: unknown): boolean => {
    const def = registry.get(toolName)
    if (!def?.isConcurrencySafe) return false
    try {
      return def.isConcurrencySafe(input)
    } catch {
      return false
    }
  }
}
