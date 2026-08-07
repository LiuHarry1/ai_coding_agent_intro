/**
 * TaskStop — Claude Code TaskStopTool / KillShell.
 */
import { tool } from 'ai'
import { z } from 'zod'
import type {
  DualChannelToolResult,
  ToolDefinition,
  ToolContext,
} from '../../core/types.js'
import { TASK_STOP_TOOL_NAME } from '../../constants/tool_names.js'
import { stopTask } from '../../tasks/stopTask.js'
import { setTaskSessionId } from '../../utils/task/diskOutput.js'

export type TaskStopToolResult = {
  text: string
  task_id: string
  stopped: boolean
  message: string
}

export const TaskStopToolResultSchema = z.object({
  text: z.string(),
  task_id: z.string(),
  stopped: z.boolean(),
  message: z.string(),
})

const DESCRIPTION = `Stop a background shell task by task_id (from Bash/PowerShell run_in_background).`

export const definition: ToolDefinition = {
  name: TASK_STOP_TOOL_NAME,
  description: DESCRIPTION,
  isConcurrencySafe: () => false,
  outputSchema: TaskStopToolResultSchema,
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const o = output as TaskStopToolResult
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: o.text,
    }
  },
  create(_cwd: string, context: ToolContext) {
    return tool({
      description: DESCRIPTION,
      inputSchema: z.object({
        task_id: z
          .string()
          .optional()
          .describe('Background task id to stop'),
        shell_id: z
          .string()
          .optional()
          .describe('Deprecated alias for task_id'),
      }),
      execute: async (args: {
        task_id?: string
        shell_id?: string
      }): Promise<DualChannelToolResult<TaskStopToolResult> | string> => {
        const taskId = args.task_id ?? args.shell_id
        if (!taskId) {
          return 'Error: provide task_id'
        }
        const sessionId = context.sessionId ?? 'default'
        setTaskSessionId(sessionId)
        try {
          const { message } = await stopTask(
            sessionId,
            taskId,
            context.execution,
          )
          return {
            data: {
              text: message,
              task_id: taskId,
              stopped: true,
              message,
            },
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return `Error: ${msg}`
        }
      },
    })
  },
}
