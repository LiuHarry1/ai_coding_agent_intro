/**
 * Canonical tool names — claude-code-rev `constants/tools.ts` equivalent.
 * Import from here everywhere.
 */

export const BASH_TOOL_NAME = 'Bash'
export const POWERSHELL_TOOL_NAME = 'PowerShell'
export const READ_FILE_TOOL_NAME = 'Read'
export const WRITE_FILE_TOOL_NAME = 'Write'
export const EDIT_FILE_TOOL_NAME = 'Edit'
export const LIST_DIR_TOOL_NAME = 'list_dir'
export const TODO_WRITE_TOOL_NAME = 'TodoWrite'
export const WEB_SEARCH_TOOL_NAME = 'WebSearch'
export const WEB_FETCH_TOOL_NAME = 'WebFetch'
export const GLOB_TOOL_NAME = 'Glob'
export const GREP_TOOL_NAME = 'Grep'
export const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion'
export const PUBLISH_PREVIEW_TOOL_NAME = 'PublishPreview'
export const TOOL_SEARCH_TOOL_NAME = 'ToolSearch'
export const SKILL_TOOL_NAME = 'Skill'
export const AGENT_TOOL_NAME = 'Agent'
export const ENTER_PLAN_MODE_TOOL_NAME = 'EnterPlanMode'
export const EXIT_PLAN_MODE_TOOL_NAME = 'ExitPlanMode'

/** @deprecated Use {@link AGENT_TOOL_NAME}. */
export const TASK_TOOL_NAME = AGENT_TOOL_NAME

export const MUTATING_TOOLS: readonly string[] = [
  WRITE_FILE_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
]

export const INTERACTIVE_TOOLS: readonly string[] = [
  ASK_USER_QUESTION_TOOL_NAME,
]

/** Read-only tools allowed in Ask mode. */
export const READ_ONLY_TOOLS: readonly string[] = [
  READ_FILE_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
]

/** Tools denied in Plan mode (plan file writes allowed via guard). */
export const PLAN_MODE_DENIED_TOOLS: readonly string[] = [
  ...MUTATING_TOOLS.filter(
    t => t !== WRITE_FILE_TOOL_NAME && t !== EDIT_FILE_TOOL_NAME,
  ),
  BASH_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
]
