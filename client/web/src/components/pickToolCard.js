/**
 * Tool card registry + picker (≈ Cursor ComposerToolFormer routing).
 *
 * Metadata (chrome / exploreGroupable) lives in lib/tool-registry-meta.js;
 * this module binds React components and resolves special cases
 * (Skill, subagent, MCP, nested fallback).
 */

import ToolCallCard from './ToolCallCard.jsx'
import FileChangeCard from './FileChangeCard.jsx'
import ReadFileCard from './ReadFileCard.jsx'
import ListDirCard from './ListDirCard.jsx'
import BashCard from './BashCard.jsx'
import WebSearchCard from './WebSearchCard.jsx'
import WebFetchCard from './WebFetchCard.jsx'
import SubagentCard from './SubagentCard.jsx'
import GlobCard from './GlobCard.jsx'
import GrepCard from './GrepCard.jsx'
import ToolSearchCard from './ToolSearchCard.jsx'
import SkillCard from './SkillCard.jsx'
import McpToolCard from './McpToolCard.jsx'
import SubagentStepFallback from './SubagentStepFallback.jsx'
import TaskOutputCard from './TaskOutputCard.jsx'
import TaskStopCard from './TaskStopCard.jsx'
import BrowserToolCard from './BrowserToolCard.jsx'
import { isFetchTool, isSearchTool } from '../lib/tool-kind.js'
import { isMcpTool } from '../lib/tool-density.js'
import { getToolChrome, getToolMeta } from '../lib/tool-registry-meta.js'
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
  TASK_OUTPUT,
  TASK_STOP,
  BROWSER_TOOLS,
  SUPPRESSED_TOOL_CARDS,
  SUBAGENT_SUPPRESSED,
} from '../lib/tool-names.js'

export { SUPPRESSED_TOOL_CARDS, SUBAGENT_SUPPRESSED }

const TOOL_CARDS = {
  [WRITE]: FileChangeCard,
  [EDIT]: FileChangeCard,
  [READ]: ReadFileCard,
  [LIST_DIR]: ListDirCard,
  [BASH]: BashCard,
  [POWERSHELL]: BashCard,
  [TASK_OUTPUT]: TaskOutputCard,
  [TASK_STOP]: TaskStopCard,
  [WEB_SEARCH]: WebSearchCard,
  [WEB_FETCH]: WebFetchCard,
  [GLOB]: GlobCard,
  [GREP]: GrepCard,
  [TOOL_SEARCH]: ToolSearchCard,
  [SKILL]: SkillCard,
  ...Object.fromEntries(BROWSER_TOOLS.map(name => [name, BrowserToolCard])),
}

/**
 * @typedef {{
 *   component: import('react').ComponentType<any>,
 *   chrome: 'line' | 'card',
 *   exploreGroupable: boolean,
 * }} ToolEntry
 */

/**
 * Resolve the full tool UI entry for a tool_call part.
 * @param {object} item
 * @param {{ nested?: boolean }} [options]
 * @returns {ToolEntry}
 */
export function resolveToolEntry(item, options = {}) {
  const { nested = false } = options
  const meta = getToolMeta(item?.name)
  const exploreGroupable = meta?.exploreGroupable === true

  // Skills always render via SkillCard — must come BEFORE isSubagent.
  if (item?.name === SKILL) {
    return {
      component: SkillCard,
      chrome: 'line',
      exploreGroupable: false,
    }
  }
  if (item?.isSubagent) {
    return {
      component: SubagentCard,
      chrome: 'line',
      exploreGroupable: false,
    }
  }

  const name = item?.name
  if (name && TOOL_CARDS[name]) {
    return {
      component: TOOL_CARDS[name],
      chrome: meta?.chrome ?? 'line',
      exploreGroupable,
    }
  }

  if (isMcpTool(item)) {
    return {
      component: McpToolCard,
      chrome: 'line',
      exploreGroupable: false,
    }
  }
  if (isFetchTool(name)) {
    return {
      component: WebFetchCard,
      chrome: 'line',
      exploreGroupable: true,
    }
  }
  if (isSearchTool(name)) {
    return {
      component: WebSearchCard,
      chrome: 'line',
      exploreGroupable: true,
    }
  }
  if (nested) {
    return {
      component: SubagentStepFallback,
      chrome: 'line',
      exploreGroupable: false,
    }
  }
  return {
    component: ToolCallCard,
    chrome: getToolChrome(name) || 'line',
    exploreGroupable: false,
  }
}

/** @deprecated Prefer resolveToolEntry when you need chrome / meta. */
export function pickCard(item, options = {}) {
  return resolveToolEntry(item, options).component
}
