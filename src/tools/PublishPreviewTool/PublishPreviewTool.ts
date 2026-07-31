import { tool } from 'ai'
import { z } from 'zod'
import {
  buildPreviewUrl,
  previewPortMax,
  previewPortMin,
  validatePreviewPort,
  waitForPort,
} from '../../core/preview.js'
import type { DualChannelToolResult, ToolDefinition } from '../../core/types.js'
import { PUBLISH_PREVIEW_TOOL_NAME } from '../../constants/tool_names.js'

export type PublishPreviewOutput = {
  text: string
  url?: string
  port?: number
  listening?: boolean
}

export const definition: ToolDefinition = {
  name: PUBLISH_PREVIEW_TOOL_NAME,
  description:
    'Public preview URL for a dev server in this container (call after Bash background start on 0.0.0.0)',
  isConcurrencySafe: () => true,
  shouldDefer: true,
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: (output as PublishPreviewOutput).text,
    }
  },

  create() {
    return tool({
      description:
        'Return the public preview URL for a port. Use after starting a dev server with Bash (background: true) on 0.0.0.0.',
      inputSchema: z.object({
        port: z
          .number()
          .int()
          .min(previewPortMin())
          .max(previewPortMax())
          .describe('TCP port the dev server listens on inside the container'),
        label: z
          .string()
          .optional()
          .describe('Short label, e.g. frontend or api'),
        path: z
          .string()
          .optional()
          .describe(
            'Optional path suffix appended to the preview URL, e.g. /docs',
          ),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(60)
          .optional()
          .default(5)
          .describe(
            'Seconds to wait for the port to start listening before reporting status',
          ),
      }),
      execute: async (args: {
        port: number
        label?: string
        path?: string
        wait_seconds?: number
      }): Promise<DualChannelToolResult<PublishPreviewOutput> | string> => {
        const portError = validatePreviewPort(args.port)
        if (portError) return `Error: ${portError}`

        const listening = await waitForPort(args.port, args.wait_seconds ?? 5)
        const url = buildPreviewUrl(args.port, args.path ?? '')

        if (!listening) {
          return {
            data: {
              text: `Port ${args.port} not listening. Start on 0.0.0.0, then retry.\nURL (when ready): ${url}`,
              url,
              port: args.port,
              listening: false,
            },
          }
        }

        const label = args.label ? ` (${args.label})` : ''
        return {
          data: {
            text: `Preview${label}: ${url}`,
            url,
            port: args.port,
            listening: true,
          },
        }
      },
    })
  },
}
