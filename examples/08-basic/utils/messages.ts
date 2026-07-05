/**
 * CC-aligned message normalization — expand AttachmentMessage for API requests.
 */
import * as path from 'path'
import type {
  Diagnostic,
  DiagnosticFile,
  Message,
  UserContentPart,
  UserMessage,
} from '../core/types.js'
import { isAttachmentMessage, isRoleMessage } from '../core/types.js'
import type { Attachment } from './attachments/types.js'
import { attachmentToMessages } from './attachments/attachment-to-messages.js'
import {
  ASK_USER_QUESTION_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
} from '../constants/tool_names.js'

const MAX_DIAGNOSTICS_SUMMARY_CHARS = 8000

function wrapInSystemReminder(content: string): string {
  return `<system-reminder>\n${content}\n</system-reminder>`
}

function metaUserMessage(content: string): UserMessage {
  return { role: 'user', content: wrapInSystemReminder(content), isMeta: true }
}

function severitySymbol(severity: Diagnostic['severity']): string {
  switch (severity) {
    case 'Error':
      return '✗'
    case 'Warning':
      return '⚠'
    case 'Info':
      return 'ℹ'
    case 'Hint':
      return '★'
    default:
      return '•'
  }
}

export function formatDiagnosticsSummary(files: DiagnosticFile[]): string {
  const truncationMarker = '…[truncated]'
  const result = files
    .map(file => {
      const filename = file.uri.split('/').pop() || file.uri
      const diagnostics = file.diagnostics
        .map(d => {
          return `  ${severitySymbol(d.severity)} [Line ${d.range.start.line + 1}:${d.range.start.character + 1}] ${d.message}${d.code ? ` [${d.code}]` : ''}${d.source ? ` (${d.source})` : ''}`
        })
        .join('\n')
      return `${filename}:\n${diagnostics}`
    })
    .join('\n\n')

  if (result.length > MAX_DIAGNOSTICS_SUMMARY_CHARS) {
    return (
      result.slice(
        0,
        MAX_DIAGNOSTICS_SUMMARY_CHARS - truncationMarker.length,
      ) + truncationMarker
    )
  }
  return result
}

function sparsePlanReminder(planFilePath: string): string {
  return `Plan mode still active (see full instructions earlier in conversation). Read-only except plan file (${planFilePath}). Follow 5-phase workflow. End turns with ${ASK_USER_QUESTION_TOOL_NAME} (for clarifications) or ${EXIT_PLAN_MODE_TOOL_NAME} (for plan approval). Never ask about plan approval via text or AskUserQuestion.`
}

function fullPlanReminder(planFilePath: string, exists: boolean): string {
  return `Plan mode is active. You MUST NOT make any edits except the plan file, run shell commands on the main thread, or spawn non-Explore/Plan subagents.

Plan file: ${planFilePath}${exists ? ' (exists — read it first)' : ' (not created yet)'}

Workflow: Phase 1 Explore agents → Phase 2 Plan agents → Phase 3 Review/Ask → Phase 4 Write plan file → Phase 5 ${EXIT_PLAN_MODE_TOOL_NAME}

End each turn with ${ASK_USER_QUESTION_TOOL_NAME} or ${EXIT_PLAN_MODE_TOOL_NAME} — not plain text alone.`
}

function getPlanModeInstructions(
  attachment: Extract<Attachment, { type: 'plan_mode' }>,
): UserMessage[] {
  const content =
    attachment.reminderType === 'full'
      ? fullPlanReminder(attachment.planFilePath, attachment.planExists)
      : sparsePlanReminder(attachment.planFilePath)
  return [metaUserMessage(content)]
}

export function normalizeAttachmentForAPI(attachment: Attachment): UserMessage[] {
  switch (attachment.type) {
    case 'directory':
    case 'file':
    case 'already_read_file':
    case 'pdf_reference':
      return attachmentToMessages(attachment).map(
        m => ({ ...m, isMeta: true }) as UserMessage,
      )

    case 'diagnostics': {
      if (attachment.files.length === 0) return []
      const diagnosticSummary = formatDiagnosticsSummary(attachment.files)
      return [
        metaUserMessage(
          `<new-diagnostics>The following new diagnostic issues were detected:\n\n${diagnosticSummary}</new-diagnostics>`,
        ),
      ]
    }

    case 'plan_mode':
      return getPlanModeInstructions(attachment)

    case 'plan_mode_reentry':
      return [
        metaUserMessage(`## Re-entering Plan Mode

You are returning to plan mode after having previously exited it. A plan file exists at ${attachment.planFilePath} from your previous planning session.

**Before proceeding with any new planning, you should:**
1. Read the existing plan file to understand what was previously planned
2. Evaluate the user's current request against that plan
3. Decide how to proceed:
   - **Different task**: If the user's request is for a different task—even if it's similar or related—start fresh by overwriting the existing plan
   - **Same task, continuing**: If this is explicitly a continuation or refinement of the exact same task, modify the existing plan while cleaning up outdated or irrelevant sections
4. Continue on with the plan process and most importantly you should always edit the plan file one way or the other before calling ${EXIT_PLAN_MODE_TOOL_NAME}

Treat this as a fresh planning session. Do not assume the existing plan is relevant without evaluating it first.`),
      ]

    case 'plan_mode_exit': {
      const planReference = attachment.planExists
        ? ` The plan file is located at ${attachment.planFilePath} if you need to reference it.`
        : ''
      return [
        metaUserMessage(`## Exited Plan Mode

You have exited plan mode. You can now make edits, run tools, and take actions.${planReference}`),
      ]
    }
  }
}

export function expandAttachmentMessagesForAPI(messages: Message[]): Message[] {
  const out: Message[] = []
  for (const msg of messages) {
    if (isAttachmentMessage(msg)) {
      out.push(...normalizeAttachmentForAPI(msg.attachment))
    } else {
      out.push(msg)
    }
  }
  return out
}

function normalizeUserContent(content: string | UserContentPart[]): UserContentPart[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }]
  }
  return content
}

function denormalizeUserContent(parts: UserContentPart[]): string | UserContentPart[] {
  if (parts.length === 1 && parts[0]!.type === 'text') {
    return parts[0]!.text
  }
  return parts
}

/**
 * Concatenate two content arrays, appending `\n` to a's last text block when
 * the seam is text-text. Mirrors CC's joinTextAtSeam — the API concatenates
 * adjacent text blocks without a separator, so `"2 + 2"` + `"3 + 3"` would
 * otherwise reach the model as `"2 + 23 + 3"`.
 */
function joinTextAtSeam(a: UserContentPart[], b: UserContentPart[]): UserContentPart[] {
  const lastA = a.at(-1)
  const firstB = b[0]
  if (lastA?.type === 'text' && firstB?.type === 'text') {
    return [...a.slice(0, -1), { ...lastA, text: lastA.text + '\n' }, ...b]
  }
  return [...a, ...b]
}

/** Merge two adjacent user messages into one (CC mergeUserMessages). */
export function mergeUserMessages(a: UserMessage, b: UserMessage): UserMessage {
  const merged = joinTextAtSeam(
    normalizeUserContent(a.content),
    normalizeUserContent(b.content),
  )
  return {
    role: 'user',
    content: denormalizeUserContent(merged),
    // Merged message is meta only when every operand is meta.
    isMeta: a.isMeta && b.isMeta ? true : undefined,
  }
}

/**
 * Collapse consecutive `role: user` messages before the SDK/provider sees
 * them. History and JSONL keep fine-grained attachment structure; this runs
 * only at API request time (CC mergeAdjacentUserMessages).
 */
export function mergeAdjacentUserMessages(messages: Message[]): Message[] {
  const out: Message[] = []
  for (const m of messages) {
    const prev = out.at(-1)
    if (
      isRoleMessage(m) &&
      m.role === 'user' &&
      prev !== undefined &&
      isRoleMessage(prev) &&
      prev.role === 'user'
    ) {
      out[out.length - 1] = mergeUserMessages(prev, m)
    } else {
      out.push(m)
    }
  }
  return out
}

export function formatDiagnosticFilePath(cwd: string, filePath: string): string {
  const relative = path.relative(cwd, filePath).replaceAll('\\', '/')
  return relative && !relative.startsWith('..') ? relative : filePath
}
