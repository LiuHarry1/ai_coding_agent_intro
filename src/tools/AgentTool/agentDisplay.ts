import type { AgentDefinition, AgentSource } from '../../core/types.js'

export type ResolvedAgent = AgentDefinition & {
  overriddenBy?: AgentSource
}

export const AGENT_SOURCE_GROUPS: Array<{ label: string; source: AgentSource }> =
  [
    { label: 'Managed agents', source: 'managed' },
    { label: 'Project agents', source: 'project' },
    { label: 'User agents', source: 'user' },
    { label: 'Plugin agents', source: 'plugin' },
    { label: 'Built-in agents', source: 'built-in' },
  ]

/**
 * Annotate agents with override info by comparing the full discovery set
 * against the active (winning) list.
 */
export function resolveAgentOverrides(
  allAgents: readonly AgentDefinition[],
  activeAgents: readonly AgentDefinition[],
): ResolvedAgent[] {
  const activeMap = new Map<string, AgentDefinition>()
  for (const agent of activeAgents) {
    activeMap.set(agent.agentType, agent)
  }

  const seen = new Set<string>()
  const resolved: ResolvedAgent[] = []

  for (const agent of allAgents) {
    const key = `${agent.agentType}:${agent.source ?? 'unknown'}`
    if (seen.has(key)) continue
    seen.add(key)

    const active = activeMap.get(agent.agentType)
    const overriddenBy =
      active && active.source !== agent.source ? active.source : undefined

    resolved.push({
      ...agent,
      overriddenBy,
    })
  }

  return resolved
}

export function compareAgentsByName(
  a: AgentDefinition,
  b: AgentDefinition,
): number {
  return a.agentType.localeCompare(b.agentType, undefined, {
    sensitivity: 'base',
  })
}
