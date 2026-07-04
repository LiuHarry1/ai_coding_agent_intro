export type {
  Attachment,
  FileAttachment,
  PdfReferenceAttachment,
  DirectoryAttachment,
  AlreadyReadFileAttachment,
  ReadFileState,
} from './types.js'
export {
  extractAtMentionedFiles,
  parseAtMentionedFileLines,
} from './extract-mentions.js'
export {
  generateFileAttachment,
  getAttachmentsForInput,
} from './generate-file-attachment.js'
export {
  attachmentToMessages,
  attachmentsToMessages,
} from './attachment-to-messages.js'

import type { Message } from '../../core/types.js'
import type { ReadFileState } from './types.js'
import { getAttachmentsForInput } from './generate-file-attachment.js'
import { attachmentsToMessages } from './attachment-to-messages.js'

/** CC: utils/attachments.ts → getAttachmentMessages pipeline. */
export async function buildAttachmentMessages(
  cwd: string,
  input: string,
  readFileState: ReadFileState,
): Promise<Message[]> {
  const attachments = await getAttachmentsForInput(cwd, input, readFileState)
  return attachmentsToMessages(attachments)
}
