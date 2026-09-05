import * as os from 'os'
import { randomUUID } from 'crypto'
import { getRunAgent } from '../../agent-lazy.js'
import { EventBus } from '../../core/event-bus.js'
import { scheduledTurnMessage } from '../../core/protocol-messages.js'
import { runChatTurn } from '../../turn/run-chat-turn.js'
import { runWithRequestScope } from '../../utils/request-scope.js'
import { createSessionLiveTransport } from '../session-live-hub.js'
import {
  isAuthEnabled,
  resolveUserWorkspace,
} from '../../server/auth/identity.js'
import {
  checkQuota,
  commitQuota,
  shouldEnforceQuota,
  trackTurnTokens,
} from '../../server/quota.js'
import { attachUsageTelemetry, flushUsage } from '../../server/telemetry.js'
import {
  endTurn,
  getSession,
  tryBeginTurn,
} from '../../session/store.js'
import { isScheduledTasksEnabled } from './settings.js'
import {
  computeNextRunAtMs,
  isRecurringTaskAged,
  removeCronTasks,
  updateCronTask,
} from './store.js'
import {
  MAX_TIMER_DELAY_MS,
  type FireResult,
  type ScheduledTask,
} from './types.js'

function formatFireTime(d: Date): string {
  return d
    .toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
    .replace(/,? at |, /, ' ')
    .replace(/ ([AP]M)/, (_, ampm: string) => ampm.toLowerCase())
}

export function formatScheduledPrompt(task: ScheduledTask, now: Date): string {
  return `[Scheduled task · ${formatFireTime(now)}]\n\n${task.prompt}`
}

function agentHomeForSession(ownerEmail: string | undefined): string {
  if (isAuthEnabled() && ownerEmail) {
    return resolveUserWorkspace(ownerEmail)
  }
  return os.homedir()
}

export async function fireScheduledTask(
  task: ScheduledTask,
  nowMs = Date.now(),
): Promise<FireResult> {
  if (!isScheduledTasksEnabled(task.cwd)) return 'disabled'

  const session = getSession(task.sessionId)
  if (!session) {
    removeCronTasks([task.id])
    return 'missing'
  }

  if (!tryBeginTurn(session.id)) return 'busy'

  const cwd = session.workspace?.cwd ?? task.cwd
  const eventBus = new EventBus()
  const quotaUser = session.ownerEmail
  const quotaEventId = `${session.id}:cron:${randomUUID()}`
  const turnUsage = { tokens: 0 }
  const unsubTurnTokens = trackTurnTokens(eventBus, turnUsage)
  const unsubTelemetry = attachUsageTelemetry(eventBus, {
    sessionId: session.id,
    userEmail: session.ownerEmail,
  })

  const finishQuota = async (): Promise<void> => {
    unsubTurnTokens()
    if (shouldEnforceQuota(quotaUser)) {
      try {
        await commitQuota(quotaUser!, turnUsage.tokens, quotaEventId)
      } catch (err) {
        console.warn(
          `[quota] cron commit failed: ${err instanceof Error ? err.message : err}`,
        )
      }
    }
  }

  try {
    if (shouldEnforceQuota(quotaUser)) {
      try {
        const q = await checkQuota(quotaUser!)
        if (q.exceeded) {
          updateCronTask(task.id, {
            nextRunAtMs: nowMs + MAX_TIMER_DELAY_MS,
          })
          return 'quota'
        }
      } catch (err) {
        console.warn(
          `[quota] cron status check failed: ${err instanceof Error ? err.message : err}`,
        )
      }
    }

    const runAgent = await getRunAgent()
    const transport = createSessionLiveTransport(session.id)
    const prompt = formatScheduledPrompt(task, new Date(nowMs))
    transport.emit(
      scheduledTurnMessage(prompt, { session_id: session.id }),
    )
    await runWithRequestScope(
      { agentHome: agentHomeForSession(session.ownerEmail), cwd },
      () =>
        runChatTurn({
          message: prompt,
          session,
          cwd,
          runAgent,
          transport,
          emitHandshake: false,
          isMeta: true,
          eventBus,
        }),
    )
  } catch (err) {
    console.warn(
      `[cron] fire ${task.id} failed: ${err instanceof Error ? err.message : err}`,
    )
    return 'error'
  } finally {
    endTurn(session.id)
    unsubTelemetry()
    await finishQuota()
    void flushUsage()
  }

  const aged = isRecurringTaskAged(task, nowMs)
  if (task.recurring && !aged) {
    const next = computeNextRunAtMs(task, nowMs)
    updateCronTask(task.id, {
      lastFiredAt: nowMs,
      nextRunAtMs: next ?? Number.POSITIVE_INFINITY,
    })
  } else {
    removeCronTasks([task.id])
  }
  return 'fired'
}
