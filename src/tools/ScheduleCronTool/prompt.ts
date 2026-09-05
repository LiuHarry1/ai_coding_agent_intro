export const CRON_CREATE_DESCRIPTION =
  'Schedule a prompt to run later in this session. Recurring cron (local time) or a one-shot absolute time. Disabled when settings.json has scheduledTasks.enabled=false.'

export const CRON_CREATE_PROMPT = `Schedule a follow-up agent turn in the CURRENT session.

This is NOT system crontab. Tasks only fire while the HTTP/Electron server is running.
They do not run if the user set scheduledTasks.enabled=false in .ai-agent/settings.json.

Use:
- cron: standard 5-field expression in local time, e.g. "*/10 * * * *" (every 10 minutes), "0 15 * * 1-5" (weekdays 3pm).
- at: ISO-8601 or epoch ms for a one-shot. Mutually exclusive with cron.
- prompt: the user message to execute when the timer fires.
- recurring: true (default) keeps firing until deleted or 7 days elapse. false = fire once then delete.

Do not use this for work that must run after the server exits.`

export const CRON_LIST_DESCRIPTION =
  'List scheduled prompts for this session (id, schedule, next run).'

export const CRON_DELETE_DESCRIPTION =
  'Cancel a scheduled prompt by id from CronList / CronCreate.'
