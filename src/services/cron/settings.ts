import { resolveSettings } from '../../core/settings-manager.js'
import { getDefaultWorkspace } from '../../core/workspace.js'

/** Project/user settings: `scheduledTasks.enabled`. Omitted = on. */
export function isScheduledTasksEnabled(cwd?: string): boolean {
  try {
    const dir = cwd && cwd.trim() ? cwd : getDefaultWorkspace()
    return resolveSettings(dir).config.scheduledTasks?.enabled !== false
  } catch {
    return true
  }
}
