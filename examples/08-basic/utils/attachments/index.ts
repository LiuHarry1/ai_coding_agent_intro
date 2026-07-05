export type {
  Attachment,
  FileAttachment,
  PdfReferenceAttachment,
  DirectoryAttachment,
  AlreadyReadFileAttachment,
  ReadFileState,
  DiagnosticsAttachment,
  PlanModeAttachment,
  PlanModeReentryAttachment,
  PlanModeExitAttachment,
} from './types.js'
export {
  extractAtMentionedFiles,
  parseAtMentionedFileLines,
} from './extract-mentions.js'
export {
  generateFileAttachment,
  getAttachmentsForInput,
  processAtMentionedFiles,
} from './generate-file-attachment.js'
export {
  attachmentToMessages,
  attachmentsToMessages,
} from './attachment-to-messages.js'
export {
  getPlanModeAttachments,
  getPlanModeExitAttachment,
  buildPlanApprovedFollowUps,
  PLAN_MODE_ATTACHMENT_CONFIG,
} from './plan-mode.js'

import type { Message } from '../../core/types.js'
import type { ReadFileState } from './types.js'
import { getAttachmentMessages } from '../attachments.js'

/** @deprecated Use getAttachmentMessages from utils/attachments.ts */
export async function buildAttachmentMessages(
  cwd: string,
  input: string,
  readFileState: ReadFileState,
): Promise<Message[]> {
  const out: Message[] = []
  for await (const att of getAttachmentMessages(
    input,
    {
      cwd,
      session: { id: '', messages: [], createdAt: 0, permissionMode: { mode: 'agent' } },
      readFileState,
      options: { tools: {} },
    },
    [],
  )) {
    out.push(att)
  }
  return out
}
