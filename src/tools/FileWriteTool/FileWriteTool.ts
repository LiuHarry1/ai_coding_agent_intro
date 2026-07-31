import { tool } from 'ai'
import { z } from 'zod'
import * as fs from 'fs'
import * as path from 'path'
import { resolvePath } from '../utils.js'
import {
  assertAccessibleResolved,
  policyFromContext,
} from '../../core/sandbox.js'
import type {
  DualChannelToolResult,
  ToolDefinition,
} from '../../core/types.js'

export type WriteFileOutput = {
  type: 'create' | 'update'
  filePath: string
  content: string
  numLines: number
  numChars: number
  message: string
}
import { WRITE_FILE_TOOL_NAME } from '../../constants/tool_names.js'
import { clearDeliveredDiagnosticsForFile } from '../../services/lsp/LSPDiagnosticRegistry.js'
import { getLspManager, getLspWorkspaceKey } from '../../services/lsp/manager.js'
import { isWorkerExecutionBackend } from '../../execution/worker-execution-backend.js'

export const definition: ToolDefinition = {
  name: WRITE_FILE_TOOL_NAME,
  description: 'Create or overwrite a file',
  isConcurrencySafe: () => false,
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const o = output as WriteFileOutput
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: o.message,
    }
  },
  create(cwd, context) {
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
      }): Promise<DualChannelToolResult<WriteFileOutput> | string> => {
        const lines = content.split('\n').length
        const makeData = (
          message: string,
          type: 'create' | 'update',
        ): WriteFileOutput => ({
          type,
          filePath: file_path,
          content,
          numLines: lines,
          numChars: content.length,
          message,
        })

        const execution = context.execution
        if (execution) {
          try {
            const abs = execution.resolve(cwd, file_path)
            execution.assertInWorkspace(cwd, abs, 'write')
            const existed = await execution.exists(abs)
            await execution.writeText(abs, content)
            if (isWorkerExecutionBackend(execution)) {
              try {
                const workspaceKey = getLspWorkspaceKey(
                  cwd,
                  context.lspServers,
                )
                clearDeliveredDiagnosticsForFile(workspaceKey, abs)
                await execution.lspChangeFile(abs, content)
                await execution.lspSaveFile(abs)
              } catch {
                /* LSP optional */
              }
            }
            const kind = existed ? 'update' : 'create'
            return {
              data: makeData(
                `Wrote ${file_path} (${lines} lines, ${content.length} chars) [worker:${execution.environmentId}]`,
                kind,
              ),
            }
          } catch (err) {
            return `Error: ${err instanceof Error ? err.message : String(err)}`
          }
        }

        const resolved = resolvePath(cwd, file_path)
        if ('error' in resolved) {
          return `Error: ${resolved.error || 'Invalid path'}`
        }
        const { abs } = resolved

        try {
          assertAccessibleResolved(
            abs,
            policyFromContext(cwd, context.sandbox),
            'write',
          )
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`
        }

        const existed = fs.existsSync(abs)
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, content, 'utf-8')

        const manager = getLspManager(cwd, context.lspServers)
        if (manager) {
          const workspaceKey = getLspWorkspaceKey(cwd, context.lspServers)
          clearDeliveredDiagnosticsForFile(workspaceKey, abs)
          console.log(`[lsp:diagnostics] sync write start file=${file_path}`)
          void (async () => {
            try {
              await manager.changeFile(abs, content)
              await manager.saveFile(abs)
              const server = manager.getServerForFile(abs)
              console.log(
                `[lsp:diagnostics] sync write done file=${file_path} server=${server?.name ?? 'none'} state=${server?.state ?? 'none'}`,
              )
            } catch (err) {
              console.warn(
                `[lsp] failed to sync write for ${abs}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              )
            }
          })()
        } else {
          console.log(
            `[lsp:diagnostics] sync write skip file=${file_path} reason=no-lsp-config`,
          )
        }

        return {
          data: makeData(
            `Wrote ${file_path} (${lines} lines, ${content.length} chars)`,
            existed ? 'update' : 'create',
          ),
        }
      },
    })
  },
}
