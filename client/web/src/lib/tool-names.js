/**
 * Canonical tool names — keep in sync with src/constants/tool_names.ts
 */

export const BASH = 'Bash'
export const POWERSHELL = 'PowerShell'
export const READ = 'Read'
export const WRITE = 'Write'
export const EDIT = 'Edit'
export const LIST_DIR = 'list_dir'
export const TODO_WRITE = 'TodoWrite'
export const WEB_SEARCH = 'WebSearch'
export const WEB_FETCH = 'WebFetch'
export const GLOB = 'Glob'
export const GREP = 'Grep'
export const ASK_USER_QUESTION = 'AskUserQuestion'
export const TOOL_SEARCH = 'ToolSearch'
export const SKILL = 'Skill'
export const AGENT = 'Agent'
export const ENTER_PLAN_MODE = 'EnterPlanMode'
export const EXIT_PLAN_MODE = 'ExitPlanMode'

/** Shown elsewhere (TodoListCard) — hide duplicate tool_call rows. */
export const SUPPRESSED_TOOL_CARDS = new Set([
  TODO_WRITE,
  ENTER_PLAN_MODE,
  EXIT_PLAN_MODE,
])

/** Meta tools hidden inside subagent step lists. */
export const SUBAGENT_SUPPRESSED = new Set([TODO_WRITE, TOOL_SEARCH])

/** Tools that create or modify workspace files. */
export const FILE_MUTATING_TOOLS = new Set([
  WRITE,
  EDIT,
  'write_file',
  'edit_file',
])

/** Shell tools that may indirectly change the workspace tree. */
export const SHELL_TOOLS = new Set([
  BASH,
  POWERSHELL,
  'bash',
  'powershell',
])
