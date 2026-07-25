import path from 'path'
import type { AgentDefinition, AgentSource } from '../../core/types.js'
import {
  sourceRank,
  type MarkdownFile,
} from '../../utils/markdownConfigLoader.js'
import {
  parseToolList,
  parseBool,
  parsePositiveInt,
  parseString,
  parseIdentifier,
} from '../../utils/frontmatterParser.js'
import { isModelTier } from '../../core/llm/index.js'
import {
  AGENT_TOOL_NAME,
  INTERACTIVE_TOOLS,
} from '../../constants/tool_names.js'

export interface AgentParseResult {
  agent: AgentDefinition | null
  filePath: string
  error?: string
}

export function parseAgentFromMarkdown(file: MarkdownFile): AgentParseResult {
  const fm = file.frontmatter

  const agentType = parseIdentifier(fm.name)
  if (!agentType) {
    return { agent: null, filePath: file.filePath }
  }

  const whenToUse = parseString(fm.description)
  if (!whenToUse) {
    return {
      agent: null,
      filePath: file.filePath,
      error: `agent '${agentType}': missing or empty 'description' in frontmatter`,
    }
  }

  const body = file.body.trim()
  if (!body) {
    return {
      agent: null,
      filePath: file.filePath,
      error: `agent '${agentType}': markdown body (the system prompt) is empty`,
    }
  }

  const tools = parseToolList(fm.tools)
  const disallowedRaw = parseToolList(fm.disallowedTools)

  if (tools !== undefined && disallowedRaw !== undefined) {
    return {
      agent: null,
      filePath: file.filePath,
      error: `agent '${agentType}': specify either 'tools' (allow-list) or 'disallowedTools' (deny-list), not both`,
    }
  }

  let allowedTools = tools
  if (allowedTools) {
    allowedTools = allowedTools.filter(t => t !== AGENT_TOOL_NAME)
  }
  const disallowed = disallowedRaw
    ? Array.from(new Set([...disallowedRaw, AGENT_TOOL_NAME]))
    : [...INTERACTIVE_TOOLS, AGENT_TOOL_NAME]

  const filename = path.basename(file.filePath, '.md')

  const agent: AgentDefinition = {
    agentType,
    whenToUse,
    description: parseString(fm.label) ?? `Custom agent (${filename})`,
    systemPrompt: body,
    source: file.source as AgentSource,
    filePath: file.filePath,
    ...(allowedTools !== undefined ? { tools: allowedTools } : {}),
    ...(allowedTools === undefined ? { disallowedTools: disallowed } : {}),
    ...(parsePositiveInt(fm.maxSteps) !== undefined
      ? { maxSteps: parsePositiveInt(fm.maxSteps) }
      : {}),
    ...(parseString(fm.model) !== undefined
      ? { model: parseString(fm.model) }
      : {}),
    ...(isModelTier(parseString(fm.modelTier))
      ? { modelTier: parseString(fm.modelTier) as 'large' | 'medium' | 'small' }
      : {}),
    ...(parseString(fm.label) !== undefined
      ? { label: parseString(fm.label) }
      : {}),
    ...(parseBool(fm.omitProjectRules) === true
      ? { omitProjectRules: true }
      : {}),
  }

  return { agent, filePath: file.filePath }
}

export function mergeAgents(
  builtins: readonly AgentDefinition[],
  files: readonly MarkdownFile[],
): {
  agents: AgentDefinition[]
  allAgents: AgentDefinition[]
  errors: Array<{ filePath: string; error: string }>
} {
  const errors: Array<{ filePath: string; error: string }> = []
  const byType = new Map<string, AgentDefinition>()
  const allAgents: AgentDefinition[] = builtins.map(b => ({
    ...b,
    source: 'built-in' as const,
  }))

  const builtinTypes = new Set(builtins.map(b => b.agentType))
  for (const b of allAgents) byType.set(b.agentType, b)

  const ordered = [...files].sort(
    (a, b) => sourceRank(a.source) - sourceRank(b.source),
  )

  for (const f of ordered) {
    const { agent, error, filePath } = parseAgentFromMarkdown(f)
    if (error) {
      errors.push({ filePath, error })
      console.warn(`[agents] ${error} (${filePath})`)
    }
    if (agent) {
      allAgents.push(agent)
      // Trust boundary: third-party plugins must not shadow built-in agents.
      // Some implementations enforce this structurally via `{plugin}:{name}`
      // namespacing; we use flat names, so guard explicitly.
      if (f.source === 'plugin' && builtinTypes.has(agent.agentType)) {
        const msg = `plugin agent '${agent.agentType}' may not override a built-in agent; ignored`
        errors.push({ filePath, error: msg })
        console.warn(`[agents] ${msg} (${filePath})`)
        continue
      }
      if (byType.has(agent.agentType)) {
        console.log(
          `[agents] overriding '${agent.agentType}' from ${f.filePath}`,
        )
      }
      byType.set(agent.agentType, agent)
    }
  }

  return { agents: [...byType.values()], allAgents, errors }
}
