/**
 * Tool UI metadata (no React components — safe for lib / density helpers).
 *
 * chrome:
 *   'line' — ToolCallLine / .tool-row (≈ Cursor ui-tool-call-line)
 *   'card' — bordered card shell (≈ Cursor ui-tool-call-card / file change)
 *
 * exploreGroupable: consecutive runs fold into "Explored N tools"
 *   (≈ Cursor conversation density). MCP / subagents / skills never set this.
 */

import {
  BASH,
  POWERSHELL,
  READ,
  WRITE,
  EDIT,
  LIST_DIR,
  WEB_SEARCH,
  WEB_FETCH,
  GLOB,
  GREP,
  TOOL_SEARCH,
  SKILL,
  TODO_WRITE,
  ASK_USER_QUESTION,
} from './tool-names.js'

/** @typedef {'line' | 'card'} ToolChrome */

/**
 * @type {Record<string, { chrome: ToolChrome, exploreGroupable?: boolean }>}
 */
export const TOOL_META = {
  [READ]: { chrome: 'line', exploreGroupable: true },
  [GREP]: { chrome: 'line', exploreGroupable: true },
  [GLOB]: { chrome: 'line', exploreGroupable: true },
  [LIST_DIR]: { chrome: 'line', exploreGroupable: true },
  [WEB_SEARCH]: { chrome: 'line', exploreGroupable: true },
  [WEB_FETCH]: { chrome: 'line', exploreGroupable: true },
  [TOOL_SEARCH]: { chrome: 'line', exploreGroupable: true },
  // legacy / alt spellings seen in older transcripts
  list_directory: { chrome: 'line', exploreGroupable: true },
  fetch: { chrome: 'line', exploreGroupable: true },
  search: { chrome: 'line', exploreGroupable: true },

  [BASH]: { chrome: 'line' },
  [POWERSHELL]: { chrome: 'line' },
  bash: { chrome: 'line' },
  powershell: { chrome: 'line' },

  [WRITE]: { chrome: 'card' },
  [EDIT]: { chrome: 'card' },
  write_file: { chrome: 'card' },
  edit_file: { chrome: 'card' },

  [SKILL]: { chrome: 'line' },
  [TODO_WRITE]: { chrome: 'line' },
  [ASK_USER_QUESTION]: { chrome: 'line' },
}

/** Names that fold into Explored groups (derived from TOOL_META). */
export const EXPLORE_GROUPABLE_NAMES = new Set(
  Object.entries(TOOL_META)
    .filter(([, m]) => m.exploreGroupable)
    .map(([name]) => name),
)

export function getToolMeta(name) {
  if (!name) return null
  return TOOL_META[name] ?? null
}

export function getToolChrome(name) {
  return getToolMeta(name)?.chrome ?? 'card'
}

export function isExploreGroupableName(name) {
  return EXPLORE_GROUPABLE_NAMES.has(name)
}
