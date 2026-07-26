/**
 * Re-announce agent/skill listings after full compaction (CC-aligned).
 * Compaction drops prior attachment messages; inject fresh deltas before the
 * next agent step.
 */
import type { AttachmentMessage, Message, ToolUseContext } from '../../core/types.js'
import { isAttachmentMessage } from '../../core/types.js'
import { AGENT_TOOL_NAME } from '../../constants/tool_names.js'
import { loadAgentDefinitionsForWorkspace } from '../../tools/AgentTool/loadAgents.js'
import { getAgentListingDeltaAttachments } from '../../tools/AgentTool/agentListing.js'
import { createAttachmentMessage } from '../../utils/attachments.js'

export interface CompactEnrichment {
  /** Active tool names this turn (Agent delta skipped when Agent absent). */
  toolNames: readonly string[]
  skillListingContent?: string
}

export async function buildPostCompactAttachmentMessages(
  cwd: string,
  enrichment: CompactEnrichment | undefined,
): Promise<AttachmentMessage[]> {
  if (!enrichment) return []

  const tools = Object.fromEntries(
    enrichment.toolNames.map(name => [name, {} as ToolUseContext['options']['tools'][string]]),
  ) as ToolUseContext['options']['tools']

  const out: AttachmentMessage[] = []

  if (Object.prototype.hasOwnProperty.call(tools, AGENT_TOOL_NAME)) {
    const { activeAgents } = await loadAgentDefinitionsForWorkspace(cwd)
    const toolUseContext: ToolUseContext = {
      cwd,
      session: {
        id: 'post-compact',
        permissionMode: { mode: 'agent' },
      } as ToolUseContext['session'],
      readFileState: new Map(),
      agentDefinitions: { activeAgents },
      options: { tools },
    }
    for (const delta of getAgentListingDeltaAttachments(toolUseContext, [])) {
      out.push(createAttachmentMessage(delta))
    }
  }

  const skillContent = enrichment.skillListingContent?.trim()
  if (skillContent) {
    out.push(createAttachmentMessage({ type: 'skill_listing', content: skillContent }))
  }

  return out
}

/** Count post-compact attachment messages (for tests). */
export function countPostCompactAgentListing(
  messages: readonly Message[],
): number {
  return messages.filter(
    m =>
      isAttachmentMessage(m) && m.attachment.type === 'agent_listing_delta',
  ).length
}
