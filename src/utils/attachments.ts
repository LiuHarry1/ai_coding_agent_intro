/**
 * Attachment API — unified getAttachments / getAttachmentMessages.
 */
import { randomUUID } from 'crypto'
import type {
  AttachmentMessage,
  Message,
  ToolUseContext,
} from '../core/types.js'
import type { Attachment } from './attachments/types.js'
import { processAtMentionedFiles } from './attachments/generate-file-attachment.js'
import {
  getPlanModeAttachments,
  getPlanModeExitAttachment,
} from './attachments/plan-mode.js'
import {
  checkForLSPDiagnostics,
  clearAllLSPDiagnostics,
} from '../services/lsp/LSPDiagnosticRegistry.js'
import { getLspWorkspaceKey, hasLspServers } from '../services/lsp/manager.js'
import { BASH_TOOL_NAME } from '../constants/tool_names.js'
import { getAgentListingDeltaAttachments } from '../tools/AgentTool/agentListing.js'
import { drainTaskNotifications } from '../utils/task/pendingNotifications.js'

function getSkillListingAttachments(ctx: ToolUseContext): Attachment[] {
  const content = ctx.skillListingContent?.trim()
  if (!content) return []
  return [{ type: 'skill_listing', content }]
}

function getTaskNotificationAttachments(ctx: ToolUseContext): Attachment[] {
  const sessionId = ctx.session?.id
  if (!sessionId) return []
  return drainTaskNotifications(sessionId).map(n => ({
    type: 'task_notification' as const,
    taskId: n.taskId,
    outputFile: n.outputFile,
    status: n.status,
    summary: n.summary,
    toolUseId: n.toolUseId,
    rawXml: n.rawXml,
  }))
}

async function maybe<A>(label: string, f: () => Promise<A[]>): Promise<A[]> {
  try {
    return await f()
  } catch (err) {
    console.warn(
      `[attachments] ${label} failed: ${err instanceof Error ? err.message : String(err)}`,
    )
    return []
  }
}

async function getLSPDiagnosticAttachments(
  ctx: ToolUseContext,
): Promise<Attachment[]> {
  if (!Object.keys(ctx.options.tools).includes(BASH_TOOL_NAME)) {
    return []
  }
  if (!hasLspServers(ctx.lspServers)) return []

  const workspaceKey = getLspWorkspaceKey(ctx.cwd, ctx.lspServers)
  const diagnosticSets = checkForLSPDiagnostics(workspaceKey)
  if (diagnosticSets.length === 0) return []

  const attachments: Attachment[] = diagnosticSets.map(({ files }) => ({
    type: 'diagnostics',
    files,
    isNew: true,
  }))

  clearAllLSPDiagnostics(workspaceKey)
  console.log(
    `[lsp:diagnostics] attach workspace=${workspaceKey} attachments=${attachments.length}`,
  )
  return attachments
}

export async function getAttachments(
  input: string | null,
  toolUseContext: ToolUseContext,
  messages?: Message[],
): Promise<Attachment[]> {
  const userInputAttachments = input
    ? [
        maybe('at_mentioned_files', () =>
          processAtMentionedFiles(input, {
            cwd: toolUseContext.cwd,
            readFileState: toolUseContext.readFileState,
          }),
        ),
      ]
    : []

  const allThreadAttachments = [
    ...(input
      ? [
          maybe('skill_listing', () =>
            Promise.resolve(getSkillListingAttachments(toolUseContext)),
          ),
          maybe('agent_listing_delta', () =>
            Promise.resolve(
              getAgentListingDeltaAttachments(toolUseContext, messages),
            ),
          ),
        ]
      : []),
    maybe('plan_mode', () =>
      Promise.resolve(getPlanModeAttachments(messages, toolUseContext)),
    ),
    maybe('plan_mode_exit', () =>
      Promise.resolve(getPlanModeExitAttachment(toolUseContext)),
    ),
  ]

  const mainThreadAttachments = [
    maybe('lsp_diagnostics', () => getLSPDiagnosticAttachments(toolUseContext)),
    maybe('task_notifications', () =>
      Promise.resolve(getTaskNotificationAttachments(toolUseContext)),
    ),
  ]

  const [userResults, threadResults, mainResults] = await Promise.all([
    Promise.all(userInputAttachments),
    Promise.all(allThreadAttachments),
    Promise.all(mainThreadAttachments),
  ])

  return [
    ...userResults.flat(),
    ...threadResults.flat(),
    ...mainResults.flat(),
  ].filter((a): a is Attachment => a != null)
}

export function createAttachmentMessage(
  attachment: Attachment,
): AttachmentMessage {
  return {
    type: 'attachment',
    attachment,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    isMeta: true,
  }
}

export async function* getAttachmentMessages(
  input: string | null,
  toolUseContext: ToolUseContext,
  messages?: Message[],
): AsyncGenerator<AttachmentMessage, void> {
  const attachments = await getAttachments(input, toolUseContext, messages)
  for (const attachment of attachments) {
    yield createAttachmentMessage(attachment)
  }
}

export type { Attachment } from './attachments/types.js'
