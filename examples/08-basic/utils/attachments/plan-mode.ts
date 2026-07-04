/**

 * Plan mode system-reminder attachments — Claude Code attachments.ts equivalent.

 */

import type { Message, Session } from '../../core/types.js'

import type { ExternalMode } from '../../core/permission-mode.js'

import {
  ASK_USER_QUESTION_TOOL_NAME,
  BASH_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from '../../constants/tool_names.js'

import { getPlanFilePath, planExists } from '../plans.js'

export const PLAN_MODE_ATTACHMENT_CONFIG = {
  TURNS_BETWEEN_ATTACHMENTS: 5,

  FULL_REMINDER_EVERY_N_ATTACHMENTS: 5,
} as const

function countHumanTurns(messages: Session['messages']): number {
  return messages.filter(m => m.role === 'user').length
}

function sparsePlanReminder(planFilePath: string): string {
  return `<system-reminder>

Plan mode still active (see full instructions earlier in conversation). Read-only except plan file (${planFilePath}). Follow 5-phase workflow. End turns with ${ASK_USER_QUESTION_TOOL_NAME} (for clarifications) or ${EXIT_PLAN_MODE_TOOL_NAME} (for plan approval). Never ask about plan approval via text or AskUserQuestion.

</system-reminder>`
}

function fullPlanReminder(planFilePath: string, exists: boolean): string {
  return `<system-reminder>

Plan mode is active. You MUST NOT make any edits except the plan file, run shell commands on the main thread, or spawn non-Explore/Plan subagents.



Plan file: ${planFilePath}${exists ? ' (exists — read it first)' : ' (not created yet)'}



Workflow: Phase 1 Explore agents → Phase 2 Plan agents → Phase 3 Review/Ask → Phase 4 Write plan file → Phase 5 ${EXIT_PLAN_MODE_TOOL_NAME}

End each turn with ${ASK_USER_QUESTION_TOOL_NAME} or ${EXIT_PLAN_MODE_TOOL_NAME} — not plain text alone.

</system-reminder>`
}

function planReentryReminder(planFilePath: string): string {
  return `<system-reminder>

## Re-entering Plan Mode



You are returning to plan mode after having previously exited it. A plan file exists at ${planFilePath} from your previous planning session.



**Before proceeding with any new planning, you should:**

1. Read the existing plan file to understand what was previously planned

2. Evaluate the user's current request against that plan

3. Decide how to proceed:

   - **Different task**: If the user's request is for a different task—even if it's similar or related—start fresh by overwriting the existing plan

   - **Same task, continuing**: If this is explicitly a continuation or refinement of the exact same task, modify the existing plan while cleaning up outdated or irrelevant sections

4. Continue on with the plan process and most importantly you should always edit the plan file one way or the other before calling ${EXIT_PLAN_MODE_TOOL_NAME}



Treat this as a fresh planning session. Do not assume the existing plan is relevant without evaluating it first.

</system-reminder>`
}

function planExitReminder(planFilePath: string, exists: boolean): string {
  const planReference = exists
    ? ` The plan file is located at ${planFilePath} if you need to reference it.`
    : ''
  return `<system-reminder>
## Exited Plan Mode

You have exited plan mode. You can now make edits, run tools, and take actions.${planReference}
</system-reminder>`
}

/** Strong kickoff after Build — model must not stop with text-only. */
export function planBuildKickoffReminder(planFilePath: string): string {
  return `<system-reminder>
## Plan Approved — Begin Implementation Now

The user clicked **Build** and approved your plan. You are in Agent mode with full tool access.

**Required in this turn:**
1. Call ${TODO_WRITE_TOOL_NAME} if the plan has multiple phases or steps.
2. Start implementing Phase 1 immediately — use ${WRITE_FILE_TOOL_NAME}, ${EDIT_FILE_TOOL_NAME}, and ${BASH_TOOL_NAME} to make real code changes.
3. Do NOT end your turn with only text. You must call at least one mutating tool before stopping.

Approved plan file: ${planFilePath}
</system-reminder>`
}

function attachmentToMessage(text: string): Message {
  return { role: 'user', content: text }
}

/** Follow-up messages injected after ExitPlanMode approval (after tool result). */
export function buildPlanApprovedFollowUps(
  planFilePath: string,
  exists: boolean,
): Message[] {
  return [
    attachmentToMessage(planExitReminder(planFilePath, exists)),
    attachmentToMessage(planBuildKickoffReminder(planFilePath)),
  ]
}

export function buildPlanModeAttachments(
  session: Session,

  cwd: string,

  mode: ExternalMode,
): Message[] {
  const messages: Message[] = []

  const planFilePath = getPlanFilePath(session, cwd)

  const exists = planExists(session, cwd)

  if (session.needsPlanModeExitAttachment && mode !== 'plan') {
    session.needsPlanModeExitAttachment = false

    messages.push(attachmentToMessage(planExitReminder(planFilePath, exists)))

    return messages
  }

  if (mode !== 'plan') return messages

  const humanTurns = countHumanTurns(session.messages)

  const throttle = PLAN_MODE_ATTACHMENT_CONFIG.TURNS_BETWEEN_ATTACHMENTS

  if (session.hasExitedPlanMode && exists) {
    session.hasExitedPlanMode = false

    messages.push(attachmentToMessage(planReentryReminder(planFilePath)))

    return messages
  }

  if (humanTurns % throttle !== 0 && humanTurns > 0) {
    return messages
  }

  const attachmentCount = Math.floor(humanTurns / throttle)

  const isFull =
    attachmentCount %
      PLAN_MODE_ATTACHMENT_CONFIG.FULL_REMINDER_EVERY_N_ATTACHMENTS ===
    0

  messages.push(
    attachmentToMessage(
      isFull
        ? fullPlanReminder(planFilePath, exists)
        : sparsePlanReminder(planFilePath),
    ),
  )

  return messages
}
