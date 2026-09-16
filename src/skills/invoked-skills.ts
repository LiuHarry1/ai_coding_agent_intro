/**
 * Session-scoped invoked-skill registry (CC STATE.invokedSkills).
 *
 * Inline Skill / `/skill` register the expanded body here so full compact
 * can re-inject it as an `invoked_skills` attachment. Multi-session HTTP
 * cannot use CC's process-global Map — the Session object is the owner.
 */
import {
  isAttachmentMessage,
  type Message,
  type Session,
} from '../core/types.js'

export type InvokedSkillInfo = {
  skillName: string
  skillPath: string
  content: string
  invokedAt: number
  agentId: string | null
}

function skillKey(agentId: string | null, skillName: string): string {
  return `${agentId ?? ''}:${skillName}`
}

export function addInvokedSkill(
  session: Session,
  skillName: string,
  skillPath: string,
  content: string,
  agentId: string | null = null,
): void {
  if (!session.invokedSkills) session.invokedSkills = new Map()
  session.invokedSkills.set(skillKey(agentId, skillName), {
    skillName,
    skillPath,
    content,
    invokedAt: Date.now(),
    agentId,
  })
}

export function getInvokedSkillsForAgent(
  session: Session,
  agentId: string | undefined | null,
): InvokedSkillInfo[] {
  const normalizedId = agentId ?? null
  const out: InvokedSkillInfo[] = []
  for (const skill of session.invokedSkills?.values() ?? []) {
    if (skill.agentId === normalizedId) out.push(skill)
  }
  return out
}

/**
 * Rebuild invokedSkills (and the skill-listing fire-once latch) from the
 * transcript. CC `restoreSkillStateFromMessages` — needed so a compact after
 * resume still has skill bodies to re-attach.
 */
export function restoreInvokedSkillsFromMessages(
  session: Session,
  messages: readonly Message[],
): void {
  for (const message of messages) {
    if (!isAttachmentMessage(message)) continue
    if (message.attachment.type === 'invoked_skills') {
      for (const skill of message.attachment.skills) {
        if (skill.name && skill.path && skill.content) {
          addInvokedSkill(session, skill.name, skill.path, skill.content, null)
        }
      }
    }
    if (message.attachment.type === 'skill_listing') {
      session.skillListingAnnounced = true
    }
  }
}
