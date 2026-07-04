/**
 * EnterPlanMode — model-initiated transition to plan mode.
 */
import { tool } from 'ai'
import { z } from 'zod'
import type { ToolDefinition } from '../core/types.js'
import { ENTER_PLAN_MODE_TOOL_NAME } from '../constants/tool_names.js'
import {
  handlePlanModeTransition,
  prepareContextForPlanMode,
} from '../core/permission-mode.js'

const DESCRIPTION =
  'Request to enter plan mode for designing an implementation before making changes.'

export const definition: ToolDefinition = {
  name: ENTER_PLAN_MODE_TOOL_NAME,
  description: DESCRIPTION,
  isConcurrencySafe: () => true,
  create(_cwd, context) {
    return tool({
      description: `${DESCRIPTION}

Use when the task is complex, ambiguous, or risky and you need to explore and design before executing.
Do NOT use for simple, obvious tasks — execute directly instead.`,
      inputSchema: z.strictObject({}),
      execute: async () => {
        const session = context.session
        if (!session) {
          return { message: 'EnterPlanMode requires an active session.' }
        }

        const from = session.permissionMode.mode
        if (from === 'plan') {
          return { message: 'Already in plan mode.' }
        }

        handlePlanModeTransition(from, 'plan', session)
        session.permissionMode = prepareContextForPlanMode(
          session.permissionMode,
        )

        context.eventBus.emit('mode_changed', { mode: 'plan' })

        return {
          message:
            'Entered plan mode. Follow the 5-phase workflow: Explore agents → Plan agents → Review/Ask → write plan file → ExitPlanMode for approval.',
        }
      },
    })
  },
}
