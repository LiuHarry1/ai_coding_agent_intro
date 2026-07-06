import type { AgentDefinition } from '../../core/types.js'
import { AGENT_TOOL_NAME } from '../../constants/tool_names.js'
import type { Message } from '../../core/types.js'
import { isAttachmentMessage } from '../../core/types.js'
import type { AgentListingDeltaAttachment } from '../../utils/attachments/types.js'
import type { ToolUseContext } from '../../core/types.js'

function getToolsDescription(agent: AgentDefinition): string {
  const { tools, disallowedTools } = agent
  const hasAllowlist = tools && tools.length > 0
  const hasDenylist = disallowedTools && disallowedTools.length > 0

  if (hasAllowlist && hasDenylist) {
    const denySet = new Set(disallowedTools)
    const effectiveTools = tools!.filter(t => !denySet.has(t))
    return effectiveTools.length === 0 ? 'None' : effectiveTools.join(', ')
  }
  if (hasAllowlist) return tools!.join(', ')
  if (hasDenylist) return `All tools except ${disallowedTools!.join(', ')}`
  return 'All tools'
}

/** `- type: whenToUse (Tools: ...)` — shared by Agent tool description and attachments. */
export function formatAgentLine(agent: AgentDefinition): string {
  return `- ${agent.agentType}: ${agent.whenToUse} (Tools: ${getToolsDescription(agent)})`
}

/**
 * When true, the agent directory lives in `agent_listing_delta` attachments
 * (system-reminder) instead of the Agent tool description — keeps the tool
 * schema stable across hot-reloads. Default on; set `AI_AGENT_LIST_IN_MESSAGES=false` to disable.
 */
export function shouldInjectAgentListInMessages(): boolean {
  const raw = process.env.AI_AGENT_LIST_IN_MESSAGES?.trim().toLowerCase()
  if (raw === 'false' || raw === '0') return false
  return true
}

export function buildAgentListSection(agents: readonly AgentDefinition[]): string {
  if (shouldInjectAgentListInMessages()) {
    return `Available agent types are listed in <system-reminder> messages in the conversation.`
  }
  return `Available agent types and the tools they have access to:\n${agents.map(formatAgentLine).join('\n')}`
}

function reconstructAnnouncedAgentTypes(messages: Message[] | undefined): Set<string> {
  const announced = new Set<string>()
  for (const msg of messages ?? []) {
    if (!isAttachmentMessage(msg)) continue
    if (msg.attachment.type !== 'agent_listing_delta') continue
    const att = msg.attachment as AgentListingDeltaAttachment
    for (const t of att.addedTypes) announced.add(t)
    for (const t of att.removedTypes) announced.delete(t)
  }
  return announced
}

/**
 * Diff current agents against prior `agent_listing_delta` attachments in the
 * transcript. Returns [] when nothing changed or injection is disabled.
 */
export function getAgentListingDeltaAttachments(
  toolUseContext: ToolUseContext,
  messages: Message[] | undefined,
): AgentListingDeltaAttachment[] {
  if (!shouldInjectAgentListInMessages()) return []

  const activeAgents = toolUseContext.agentDefinitions?.activeAgents
  if (!activeAgents?.length) return []

  if (!Object.prototype.hasOwnProperty.call(toolUseContext.options.tools, AGENT_TOOL_NAME)) {
    return []
  }

  const announced = reconstructAnnouncedAgentTypes(messages)
  const currentTypes = new Set(activeAgents.map(a => a.agentType))
  const added = activeAgents.filter(a => !announced.has(a.agentType))
  const removed: string[] = []
  for (const t of announced) {
    if (!currentTypes.has(t)) removed.push(t)
  }

  if (added.length === 0 && removed.length === 0) return []

  added.sort((a, b) => a.agentType.localeCompare(b.agentType))
  removed.sort()

  return [
    {
      type: 'agent_listing_delta',
      addedTypes: added.map(a => a.agentType),
      addedLines: added.map(formatAgentLine),
      removedTypes: removed,
      isInitial: announced.size === 0,
    },
  ]
}
