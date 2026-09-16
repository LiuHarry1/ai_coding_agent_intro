/**
 * Re-announce agent listings + invoked skills after full compaction.
 * Compaction drops prior attachment messages; inject fresh deltas before the
 * next agent step. Skill catalog (`skill_listing`) is intentionally NOT
 * re-injected — CC keeps Skill in the tool schema and restores used skill
 * bodies via `invoked_skills`.
 */
import type { AttachmentMessage, Message, ToolUseContext } from '../../core/types.js'
import { isAttachmentMessage } from '../../core/types.js'
import { AGENT_TOOL_NAME } from '../../constants/tool_names.js'
import { loadAgentDefinitionsForWorkspace } from '../../tools/AgentTool/loadAgents.js'
import { getAgentListingDeltaAttachments } from '../../tools/AgentTool/agentListing.js'
import { createAttachmentMessage } from '../../utils/attachments.js'
import type { InvokedSkillInfo } from '../../skills/invoked-skills.js'

/** CC compact.ts — per-skill cap after full compact. */
export const POST_COMPACT_MAX_TOKENS_PER_SKILL = 5_000
/** CC compact.ts — total budget across invoked skills. */
export const POST_COMPACT_SKILLS_TOKEN_BUDGET = 25_000

const SKILL_TRUNCATION_MARKER =
  '\n\n[... skill content truncated for compaction; use Read on the skill path if you need the full text]'

export interface CompactEnrichment {
  /** Active tool names this turn (Agent delta skipped when Agent absent). */
  toolNames: readonly string[]
  /**
   * Live read of invoked skills at compact time (not a query-start snapshot),
   * so a skill invoked mid-turn is included in the same-loop compact.
   */
  getInvokedSkills?: () => InvokedSkillInfo[]
}

function roughTokenCount(content: string): number {
  return Math.ceil(content.length / 4)
}

function truncateToTokens(content: string, maxTokens: number): string {
  if (roughTokenCount(content) <= maxTokens) return content
  const charBudget = maxTokens * 4 - SKILL_TRUNCATION_MARKER.length
  return content.slice(0, Math.max(0, charBudget)) + SKILL_TRUNCATION_MARKER
}

/**
 * CC `createSkillAttachmentIfNeeded`. Sorted most-recent-first so budget
 * pressure drops the least-recent skills. Per-skill truncation keeps the head.
 */
export function createSkillAttachmentIfNeeded(
  skills: readonly InvokedSkillInfo[],
): AttachmentMessage | null {
  if (skills.length === 0) return null

  let usedTokens = 0
  const packed = [...skills]
    .sort((a, b) => b.invokedAt - a.invokedAt)
    .map(skill => ({
      name: skill.skillName,
      path: skill.skillPath,
      content: truncateToTokens(
        skill.content,
        POST_COMPACT_MAX_TOKENS_PER_SKILL,
      ),
    }))
    .filter(skill => {
      const tokens = roughTokenCount(skill.content)
      if (usedTokens + tokens > POST_COMPACT_SKILLS_TOKEN_BUDGET) {
        return false
      }
      usedTokens += tokens
      return true
    })

  if (packed.length === 0) return null

  return createAttachmentMessage({
    type: 'invoked_skills',
    skills: packed,
  })
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

  const skillAttachment = createSkillAttachmentIfNeeded(
    enrichment.getInvokedSkills?.() ?? [],
  )
  if (skillAttachment) out.push(skillAttachment)

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
