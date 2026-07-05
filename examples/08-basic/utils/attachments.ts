/**
 * CC-aligned attachment API — unified getAttachments / getAttachmentMessages.
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
import {
  getLspWorkspaceKey,
  hasLspServers,
} from '../services/lsp/manager.js'
import { BASH_TOOL_NAME } from '../constants/tool_names.js'

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

async function getDiagnosticAttachments(
  _ctx: ToolUseContext,
): Promise<Attachment[]> {
  return []
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
    maybe('plan_mode', () =>
      Promise.resolve(getPlanModeAttachments(messages, toolUseContext)),
    ),
    maybe('plan_mode_exit', () =>
      Promise.resolve(getPlanModeExitAttachment(toolUseContext)),
    ),
  ]

  const mainThreadAttachments = [
    maybe('diagnostics', () => getDiagnosticAttachments(toolUseContext)),
    maybe('lsp_diagnostics', () => getLSPDiagnosticAttachments(toolUseContext)),
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
