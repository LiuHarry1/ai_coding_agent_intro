import { tool } from 'ai'
import { z } from 'zod'
import * as fs from 'fs'
import * as path from 'path'
import { resolvePath } from './utils.js'
import { assertPathInWorkspace } from '../core/workspace.js'
import type { ToolDefinition } from '../core/types.js'
import { WRITE_FILE_TOOL_NAME } from '../constants/tool_names.js'

export const definition: ToolDefinition = {
  name: WRITE_FILE_TOOL_NAME,
  description: 'Create or overwrite a file',
  isConcurrencySafe: () => false,
  create(cwd) {
    return tool({
      description:
        'Create a new file or fully overwrite an existing one. ' +
        'Creates parent directories automatically. ' +
        'Use for NEW files only. For modifying existing files, use edit_file instead.',
      inputSchema: z.object({
        file_path: z.string().describe('Path to write (relative to cwd)'),
        content: z.string().describe('Full file content'),
      }),
      execute: async ({
        file_path,
        content,
      }: {
        file_path: string
        content: string
      }) => {
        const resolved = resolvePath(cwd, file_path)
        if ('error' in resolved) return resolved.error
        const { abs } = resolved

        try {
          assertPathInWorkspace(abs, cwd)
        } catch (err) {
          return (err as Error).message
        }

        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, content, 'utf-8')

        const lines = content.split('\n').length
        return `Wrote ${file_path} (${lines} lines, ${content.length} chars)`
      },
    })
  },
}
