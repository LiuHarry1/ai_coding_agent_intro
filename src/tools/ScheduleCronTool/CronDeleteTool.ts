import { tool } from 'ai'
import { z } from 'zod'
import type { DualChannelToolResult, ToolDefinition } from '../../core/types.js'
import { CRON_DELETE_TOOL_NAME } from '../../constants/tool_names.js'
import { cancelCronTask } from '../../services/cron/index.js'
import { CRON_DELETE_DESCRIPTION } from './prompt.js'

export const CronDeleteOutputSchema = z.object({
  id: z.string(),
  removed: z.boolean(),
  message: z.string(),
})

export type CronDeleteOutput = z.infer<typeof CronDeleteOutputSchema>

export const definition: ToolDefinition = {
  name: CRON_DELETE_TOOL_NAME,
  description: CRON_DELETE_DESCRIPTION,
  shouldDefer: true,
  isConcurrencySafe: () => false,
  outputSchema: CronDeleteOutputSchema,
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const o = output as CronDeleteOutput
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: o.message,
    }
  },
  create(_cwd, context) {
    return tool({
      description: CRON_DELETE_DESCRIPTION,
      inputSchema: z.object({
        id: z.string().describe('Task id from CronCreate / CronList'),
      }),
      execute: async ({ id }) => {
        const sessionId = context.session?.id
        if (!sessionId) {
          throw new Error('CronDelete requires an active session')
        }
        const { removed } = cancelCronTask(sessionId, id)
        const data: CronDeleteOutput = {
          id,
          removed,
          message: removed
            ? `Cancelled scheduled task ${id}.`
            : `No scheduled task ${id} in this session.`,
        }
        return { data } satisfies DualChannelToolResult<CronDeleteOutput>
      },
    })
  },
}
