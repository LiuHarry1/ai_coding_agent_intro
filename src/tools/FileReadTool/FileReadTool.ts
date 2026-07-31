import { tool } from 'ai'
import { z } from 'zod'
import type {
  DualChannelToolResult,
  ToolDefinition,
} from '../../core/types.js'
import { READ_FILE_TOOL_NAME, buildReadToolDescription } from './prompt.js'
import {
  readFileCore,
  formatReadOutputAsToolString,
  resolveFileInCwd,
  ReadOutputSchema,
  type ReadOutput,
} from '../../utils/read/index.js'
import { PDF_MAX_PAGES_PER_READ } from '../../constants/api_limits.js'
import {
  assertAccessibleResolved,
  policyFromContext,
} from '../../core/sandbox.js'

/** FileReadTool — dual-channel: `{ data: ReadOutput }` + mapper. */
export const definition: ToolDefinition = {
  name: READ_FILE_TOOL_NAME,
  description: 'Read files, images, PDFs, notebooks',
  isConcurrencySafe: () => true,
  outputSchema: ReadOutputSchema,
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: formatReadOutputAsToolString(output as ReadOutput),
    }
  },
  create(cwd, context) {
    return tool({
      description: buildReadToolDescription(),
      inputSchema: z.object({
        file_path: z.string().describe('Path to the file (relative to cwd)'),
        offset: z
          .number()
          .optional()
          .describe('Line to start from (1-based). Negative counts from end'),
        limit: z.number().optional().describe('Max number of lines to return'),
        pages: z
          .string()
          .optional()
          .describe(
            `Page range for PDF files (e.g. "1-5", "3"). Max ${PDF_MAX_PAGES_PER_READ} pages per request.`,
          ),
      }),
      execute: async ({
        file_path,
        offset,
        limit,
        pages,
      }: {
        file_path: string
        offset?: number
        limit?: number
        pages?: string
      }): Promise<DualChannelToolResult<ReadOutput> | string> => {
        const execution = context.execution
        if (execution) {
          try {
            const abs = execution.resolve(cwd, file_path)
            execution.assertInWorkspace(cwd, abs, 'read')
            if (pages) {
              return 'Error: PDF page reads are not supported over SSH yet. Use bash to inspect PDFs remotely.'
            }
            const text = await execution.readText(abs)
            const lines = text.split('\n')
            const start =
              offset != null && offset < 0
                ? Math.max(0, lines.length + offset)
                : Math.max(0, (offset ?? 1) - 1)
            const end = limit != null ? start + limit : lines.length
            const slice = lines.slice(start, end)
            const numbered = slice
              .map((l, i) => `${String(start + i + 1).padStart(6)}│${l}`)
              .join('\n')
            const content =
              numbered || `(empty file or no lines in range)`
            const header = `${file_path} (lines ${start + 1}-${start + Math.max(slice.length, 1)} of ${lines.length})\n`
            const data: ReadOutput = {
              type: 'text',
              file: {
                filePath: file_path,
                content: header + content,
                numLines: slice.length,
                startLine: start + 1,
                totalLines: lines.length,
              },
            }
            return { data }
          } catch (err) {
            return `Error: ${err instanceof Error ? err.message : String(err)}`
          }
        }

        const resolved = resolveFileInCwd(cwd, file_path)
        if ('error' in resolved) return `Error: ${resolved.error}`

        try {
          assertAccessibleResolved(
            resolved.abs,
            policyFromContext(cwd, context.sandbox),
            'read',
          )
        } catch (err) {
          return err instanceof Error ? err.message : String(err)
        }

        try {
          const { output, followUpMessages } = await readFileCore(
            cwd,
            file_path,
            { offset, limit, pages },
          )
          return {
            data: output,
            newMessages: followUpMessages,
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return `Error: ${msg}`
        }
      },
    })
  },
}
