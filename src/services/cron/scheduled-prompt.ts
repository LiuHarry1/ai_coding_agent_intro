/**
 * Scheduled-turn prompt format, kept out of `fire.ts` so the session UI
 * projection can recognise such a turn without pulling in the cron runtime.
 */
import type { ScheduledTask } from './types.js'

const SCHEDULED_PROMPT_PREFIX = '[Scheduled task · '

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
  return `${SCHEDULED_PROMPT_PREFIX}${formatFireTime(now)}]\n\n${task.prompt}`
}

/**
 * Cron turns are stored `isMeta` (they are not human input for memory
 * recall), yet the live UI does bubble them — so transcript reload has to
 * tell them apart from API-side injections.
 */
export function isScheduledPromptText(text: string): boolean {
  return text.startsWith(SCHEDULED_PROMPT_PREFIX)
}
