import { tool } from 'ai'
import { z } from 'zod'
import type { DualChannelToolResult, ToolDefinition } from '../../core/types.js'
import { CRON_LIST_TOOL_NAME } from '../../constants/tool_names.js'
import {
  cronToHuman,
  listCronTasksForSession,
} from '../../services/cron/index.js'
import { CRON_LIST_DESCRIPTION } from './prompt.js'

export const CronListOutputSchema = z.object({
  tasks: z.array(
    z.object({
      id: z.string(),
      schedule: z.string(),
      prompt: z.string(),
      recurring: z.boolean(),
      nextRunAtMs: z.number(),
    }),
  ),
  message: z.string(),
})

export type CronListOutput = z.infer<typeof CronListOutputSchema>

export const definition: ToolDefinition = {
  name: CRON_LIST_TOOL_NAME,
  description: CRON_LIST_DESCRIPTION,
  shouldDefer: true,
  isConcurrencySafe: () => true,
  outputSchema: CronListOutputSchema,
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const o = output as CronListOutput
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: o.message,
    }
  },
  create(_cwd, context) {
    return tool({
      description: CRON_LIST_DESCRIPTION,
      inputSchema: z.object({}),
      execute: async () => {
        const sessionId = context.session?.id
        if (!sessionId) {
          throw new Error('CronList requires an active session')
        }
        const tasks = listCronTasksForSession(sessionId).map(t => ({
          id: t.id,
          schedule: t.cron ? cronToHuman(t.cron) : new Date(t.atMs!).toLocaleString(),
          prompt: t.prompt,
          recurring: t.recurring,
          nextRunAtMs: t.nextRunAtMs,
        }))
        const lines =
          tasks.length === 0
            ? 'No scheduled tasks in this session.'
            : tasks
                .map(
                  t =>
                    `${t.id}  ${t.schedule}  next ${new Date(t.nextRunAtMs).toISOString()}  ${t.recurring ? 'recurring' : 'once'}  ${t.prompt.slice(0, 80)}`,
                )
                .join('\n')
        const data: CronListOutput = { tasks, message: lines }
        return { data } satisfies DualChannelToolResult<CronListOutput>
      },
    })
  },
}
