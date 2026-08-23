import type { RunAgentFn } from './core/types.js'

let cached: RunAgentFn | null = null

/** Lazy-load runAgent on first /chat request (CC-style deferred init). */
export async function getRunAgent(): Promise<RunAgentFn> {
  if (!cached) {
    const mod = await import('./agent.js')
    cached = mod.runAgent
  }
  return cached
}
