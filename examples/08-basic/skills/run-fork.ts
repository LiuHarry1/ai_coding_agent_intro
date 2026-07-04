/**
 * Run a `context: fork` skill as an isolated subagent. Shared by the
 * model-facing `skill` tool, HTTP `/skills/:name/invoke`, and user
 * slash invocation (`/skill-name`).
 */

import type {
  AgentDefinition,
  AnyTool,
  CompactionConfig,
  IEventBus,
  IProvider,
  IToolRegistry,
  RunAgentFn,
  ToolContext,
} from '../core/types.js'
import { buildConcurrencyPolicy } from '../core/concurrency-policy.js'
import { AGENT_TOOL_NAME } from '../constants/tool_names.js'
import { SKILL_TOOL_NAME } from '../tools/skill.js'
import type { SkillDefinition } from './types.js'

export interface RunSkillForkOptions {
  skill: SkillDefinition
  /** Expanded skill body (preamble + substituted content). */
  combined: string
  cwd: string
  runAgent: RunAgentFn
  registry: IToolRegistry
  activeAgents: readonly AgentDefinition[]
  eventBus: IEventBus
  toolEnablement?: ToolContext['toolEnablement']
  provider?: IProvider
  compaction?: CompactionConfig
  sessionId?: string
}

export async function runSkillFork(opts: RunSkillForkOptions): Promise<string> {
  const {
    skill,
    combined,
    cwd,
    runAgent,
    registry,
    activeAgents,
    eventBus,
    toolEnablement,
    provider,
    compaction,
    sessionId,
  } = opts

  const targetAgentType = skill.agent ?? 'general_purpose'
  const targetAgent = activeAgents.find(a => a.agentType === targetAgentType)
  if (!targetAgent) {
    throw new Error(
      `Skill '${skill.name}' fork target '${targetAgentType}' not found. Available: ${activeAgents.map(a => a.agentType).join(', ')}`,
    )
  }

  const subBus = eventBus.scoped(`skill_${skill.name}`)
  subBus.emit('step_start', {
    step: 0,
    task: skill.name,
    label: `Skill: ${skill.name}`,
  })

  const subContext: ToolContext = {
    eventBus: subBus,
    registry,
    runAgent,
    toolEnablement,
    provider,
    compaction,
    sessionId,
  }

  let subTools: Record<string, AnyTool>
  if (targetAgent.tools) {
    subTools = registry.createAll(cwd, subContext, targetAgent.tools)
  } else {
    subTools = registry.createAll(cwd, subContext)
    const denied = new Set(targetAgent.disallowedTools ?? [])
    denied.add(AGENT_TOOL_NAME)
    denied.add(SKILL_TOOL_NAME)
    for (const n of denied) delete subTools[n]
  }
  delete subTools[AGENT_TOOL_NAME]
  delete subTools[SKILL_TOOL_NAME]

  if (!provider) {
    throw new Error(`Skill '${skill.name}' fork requires a request-scoped provider`)
  }

  const result = await runAgent(combined, {
    tools: subTools,
    systemPrompt: targetAgent.systemPrompt,
    eventBus: subBus,
    messages: [],
    maxSteps: targetAgent.maxSteps ?? 20,
    model: targetAgent.model,
    provider,
    cwd,
    compaction,
    concurrencyPolicy: buildConcurrencyPolicy(registry, Object.keys(subTools)),
    sessionId,
  })

  return result || `(skill ${skill.name} returned no result)`
}
