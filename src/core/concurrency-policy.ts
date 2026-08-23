import type { IToolRegistry } from './types.js'

export type ConcurrencyPolicyFn = (toolName: string, input: unknown) => boolean

/**
 * Build a runtime concurrency policy from registered tool definitions.
 * Tools without `isConcurrencySafe` default to serial execution.
 */
export function buildConcurrencyPolicy(registry: IToolRegistry): ConcurrencyPolicyFn {
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
