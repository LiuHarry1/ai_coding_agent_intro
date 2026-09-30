import {
  AGENT_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_NAME,
  BASH_TOOL_NAME,
  CRON_CREATE_TOOL_NAME,
  CRON_DELETE_TOOL_NAME,
  CRON_LIST_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  FILE_READ_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  LSP_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
  SKILL_TOOL_NAME,
  TASK_OUTPUT_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
  TOOL_SEARCH_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from '../constants/tool_names.js'

export type CodingToolManifestEntry = {
  name: string
  category: 'filesystem' | 'shell' | 'research' | 'workflow'
  registration: 'registry' | 'dynamic' | 'mode'
  platform?: 'win32'
  deferred?: boolean
  mutatesWorkspace?: boolean
}

/**
 * The explicit scope of the coding-tool conformance suite.
 * Browser automation tools and runtime MCP/plugin tools are intentionally
 * outside this manifest.
 */
export const CODING_TOOL_MANIFEST: readonly CodingToolManifestEntry[] = [
  {
    name: FILE_READ_TOOL_NAME,
    category: 'filesystem',
    registration: 'registry',
  },
  {
    name: WRITE_FILE_TOOL_NAME,
    category: 'filesystem',
    registration: 'registry',
    mutatesWorkspace: true,
  },
  {
    name: EDIT_FILE_TOOL_NAME,
    category: 'filesystem',
    registration: 'registry',
    mutatesWorkspace: true,
  },
  {
    name: GLOB_TOOL_NAME,
    category: 'filesystem',
    registration: 'registry',
  },
  {
    name: GREP_TOOL_NAME,
    category: 'filesystem',
    registration: 'registry',
  },
  {
    name: LSP_TOOL_NAME,
    category: 'filesystem',
    registration: 'registry',
    deferred: true,
  },
  { name: BASH_TOOL_NAME, category: 'shell', registration: 'registry' },
  {
    name: POWERSHELL_TOOL_NAME,
    category: 'shell',
    registration: 'registry',
    platform: 'win32',
  },
  {
    name: TASK_OUTPUT_TOOL_NAME,
    category: 'shell',
    registration: 'registry',
  },
  {
    name: TASK_STOP_TOOL_NAME,
    category: 'shell',
    registration: 'registry',
  },
  {
    name: WEB_SEARCH_TOOL_NAME,
    category: 'research',
    registration: 'registry',
    deferred: true,
  },
  {
    name: WEB_FETCH_TOOL_NAME,
    category: 'research',
    registration: 'registry',
    deferred: true,
  },
  {
    name: TODO_WRITE_TOOL_NAME,
    category: 'workflow',
    registration: 'registry',
    deferred: true,
  },
  {
    name: ASK_USER_QUESTION_TOOL_NAME,
    category: 'workflow',
    registration: 'registry',
    deferred: true,
  },
  {
    name: TOOL_SEARCH_TOOL_NAME,
    category: 'workflow',
    registration: 'dynamic',
  },
  {
    name: AGENT_TOOL_NAME,
    category: 'workflow',
    registration: 'dynamic',
  },
  {
    name: SKILL_TOOL_NAME,
    category: 'workflow',
    registration: 'dynamic',
  },
  {
    name: ENTER_PLAN_MODE_TOOL_NAME,
    category: 'workflow',
    registration: 'mode',
  },
  {
    name: EXIT_PLAN_MODE_TOOL_NAME,
    category: 'workflow',
    registration: 'mode',
  },
  {
    name: CRON_CREATE_TOOL_NAME,
    category: 'workflow',
    registration: 'registry',
    deferred: true,
  },
  {
    name: CRON_LIST_TOOL_NAME,
    category: 'workflow',
    registration: 'registry',
    deferred: true,
  },
  {
    name: CRON_DELETE_TOOL_NAME,
    category: 'workflow',
    registration: 'registry',
    deferred: true,
  },
] as const

