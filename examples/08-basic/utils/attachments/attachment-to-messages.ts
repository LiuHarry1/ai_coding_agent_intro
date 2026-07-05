import type { Message, UserContentPart, UserMessage } from '../../core/types.js'
import type { Attachment } from './types.js'
import {
  BASH_TOOL_NAME,
  READ_FILE_TOOL_NAME,
} from '../../constants/tool_names.js'
import { MAX_LINES_TO_READ } from '../../constants/api_limits.js'
import { formatReadOutputAsToolString } from '../read/index.js'
import type { ReadOutput } from '../read/types.js'

function metaUserMessage(content: string | UserContentPart[]): UserMessage {
  return { role: 'user', content, isMeta: true }
}

function createToolUseMessage(
  toolName: string,
  input: Record<string, string | number>,
): UserMessage {
  return metaUserMessage(
    `Called the ${toolName} tool with the following input: ${JSON.stringify(input)}`,
  )
}

function createToolResultTextMessage(
  toolName: string,
  resultText: string,
): UserMessage {
  return metaUserMessage(
    `Result of calling the ${toolName} tool:\n${resultText}`,
  )
}

function createToolResultImageMessage(
  toolName: string,
  output: Extract<ReadOutput, { type: 'image' }>,
): UserMessage {
  const parts: UserContentPart[] = [
    {
      type: 'text',
      text: `Result of calling the ${toolName} tool: [Image ${output.file.filePath}]`,
    },
    {
      type: 'image',
      image: Buffer.from(output.file.base64, 'base64'),
      mediaType: output.file.mediaType,
    },
  ]
  return metaUserMessage(parts)
}

function fileAttachmentToMessages(attachment: {
  filename: string
  displayPath: string
  content: ReadOutput
  truncated?: boolean
}): Message[] {
  const input = { file_path: attachment.displayPath }
  const msgs: Message[] = [createToolUseMessage(READ_FILE_TOOL_NAME, input)]

  if (attachment.content.type === 'image') {
    msgs.push(
      createToolResultImageMessage(READ_FILE_TOOL_NAME, attachment.content),
    )
  } else {
    msgs.push(
      createToolResultTextMessage(
        READ_FILE_TOOL_NAME,
        formatReadOutputAsToolString(attachment.content),
      ),
    )
  }

  if (attachment.truncated) {
    msgs.push(
      metaUserMessage(
        `Note: The file ${attachment.displayPath} was too large and has been truncated to the first ${MAX_LINES_TO_READ} lines. Don't tell the user about this truncation. Use ${READ_FILE_TOOL_NAME} to read more of the file if you need.`,
      ),
    )
  }

  return msgs
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function attachmentToMessages(attachment: Attachment): Message[] {
  switch (attachment.type) {
    case 'directory':
      return [
        createToolUseMessage(BASH_TOOL_NAME, {
          command: `ls ${JSON.stringify(attachment.path)}`,
          description: `Lists files in ${attachment.displayPath}`,
        }),
        createToolResultTextMessage(BASH_TOOL_NAME, attachment.content),
      ]

    case 'file':
    case 'already_read_file':
      return fileAttachmentToMessages(attachment)

    case 'pdf_reference':
      return [
        metaUserMessage(
          `PDF file: ${attachment.displayPath} (${attachment.pageCount} pages, ${formatFileSize(attachment.fileSize)}). ` +
            `This PDF is too large to read all at once. You MUST use the ${READ_FILE_TOOL_NAME} tool with the pages parameter ` +
            `to read specific page ranges (e.g., pages: "1-5"). Do NOT call ${READ_FILE_TOOL_NAME} without the pages parameter ` +
            `or it will fail. Start by reading the first few pages to understand the structure, then read more as needed. ` +
            `Maximum 20 pages per request.`,
        ),
      ]
    case 'plan_mode':
    case 'plan_mode_reentry':
    case 'plan_mode_exit':
    case 'diagnostics':
    case 'skill_listing':
      return []
    default: {
      const _exhaustive: never = attachment
      return _exhaustive
    }
  }
}
