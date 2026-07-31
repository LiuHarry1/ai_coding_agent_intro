/**
 * Cursor-style chat density helpers.
 *
 * Explored groups only fold built-in explore tools — never real MCP calls
 * (merged as `${server}_${tool}` in mcp-manager).
 */

import {
  BASH,
  POWERSHELL,
  READ,
  WRITE,
  EDIT,
  LIST_DIR,
  TODO_WRITE,
  WEB_SEARCH,
  WEB_FETCH,
  GLOB,
  GREP,
  ASK_USER_QUESTION,
  TOOL_SEARCH,
  SKILL,
  AGENT,
  ENTER_PLAN_MODE,
  EXIT_PLAN_MODE,
} from './tool-names.js'

/** All first-party tool names the agent registers (not MCP). */
export const BUILT_IN_TOOLS = new Set([
  BASH,
  POWERSHELL,
  READ,
  WRITE,
  EDIT,
  LIST_DIR,
  TODO_WRITE,
  WEB_SEARCH,
  WEB_FETCH,
  GLOB,
  GREP,
  ASK_USER_QUESTION,
  TOOL_SEARCH,
  SKILL,
  AGENT,
  ENTER_PLAN_MODE,
  EXIT_PLAN_MODE,
  // legacy / alt spellings seen in older transcripts
  'bash',
  'powershell',
  'write_file',
  'edit_file',
  'list_directory',
  'fetch',
  'search',
])

/**
 * Built-ins that fold into "Explored N tools" (Cursor Conversation Density).
 * ToolSearch ≈ Cursor's internal "list available MCP tools" lookup.
 */
export const EXPLORE_BUILTINS = new Set([
  READ,
  GREP,
  GLOB,
  LIST_DIR,
  WEB_SEARCH,
  WEB_FETCH,
  TOOL_SEARCH,
  'list_directory',
  'fetch',
  'search',
])

export function isExploreTool(part) {
  if (!part || part.type !== 'tool_call') return false
  if (part.isSubagent) return false
  if (part.name === SKILL) return false
  return EXPLORE_BUILTINS.has(part.name)
}

/**
 * MCP tools are merged as `${server}_${tool}` and are never in BUILT_IN_TOOLS.
 * Subagents / skills are excluded even if the name is unusual.
 */
export function isMcpTool(part) {
  if (!part || part.type !== 'tool_call') return false
  if (part.isSubagent) return false
  if (part.name === SKILL) return false
  if (!part.name) return false
  return !BUILT_IN_TOOLS.has(part.name)
}

/**
 * Coalesce consecutive explore built-ins into explored_run groups when N ≥ 2.
 *
 * Subagents are deliberately NOT coalesced: they always render as their own
 * row, matching Cursor (`taskToolCall` is excluded from the groupable set and
 * force-flushes the pending group). Turn-level folding is WorkGroup's job.
 *
 * @param {object[]} items tool_call parts
 * @returns {Array<{ type: 'explored_run', items: object[] } | { type: 'tool', part: object }>}
 */
export function coalesceToolRuns(items) {
  const out = []
  let exploreBuf = []

  const flushExplore = () => {
    if (exploreBuf.length === 0) return
    if (exploreBuf.length === 1) {
      out.push({ type: 'tool', part: exploreBuf[0] })
    } else {
      out.push({ type: 'explored_run', items: exploreBuf })
    }
    exploreBuf = []
  }

  for (const part of items) {
    if (isExploreTool(part)) {
      exploreBuf.push(part)
    } else {
      flushExplore()
      out.push({ type: 'tool', part })
    }
  }
  flushExplore()
  return out
}

/** True when any subagent (Agent / Skill fork) is still running. */
export function hasRunningSubagent(items) {
  return (items || []).some(
    p => p?.type === 'tool_call' && p.isSubagent && p.status !== 'done',
  )
}

/** Short live status for a tool_call (Explored / Subagent subtitle). */
export function liveToolSubtitle(part) {
  if (!part) return ''
  const name = part.name || 'tool'
  const args = part.args || {}
  const path =
    args.file_path ||
    args.path ||
    args.directory ||
    (typeof args.pattern === 'string' ? args.pattern : null) ||
    (typeof args.query === 'string' ? args.query : null) ||
    (typeof args.url === 'string' ? args.url : null) ||
    (typeof args.command === 'string' ? args.command : null)

  const verb =
    name === READ || name === 'read'
      ? 'Reading'
      : name === GREP
        ? 'Grepping'
        : name === GLOB
          ? 'Globbing'
          : name === LIST_DIR || name === 'list_directory'
            ? 'Listing'
            : name === WEB_SEARCH || name === 'search'
              ? 'Searching'
              : name === WEB_FETCH || name === 'fetch'
                ? 'Fetching'
                : name === TOOL_SEARCH
                  ? 'ToolSearch'
                  : name === BASH || name === POWERSHELL
                    ? 'Running'
                    : `${name}`

  if (path) {
    const short =
      typeof path === 'string' && path.length > 48
        ? `${path.slice(0, 45)}\u2026`
        : path
    return `${verb} ${short}`
  }
  return part.status === 'done' ? name : `${verb}\u2026`
}

/**
 * Latest in-flight member, else the last member — for Explored live subtitle.
 */
export function pickLiveMember(items) {
  if (!Array.isArray(items) || items.length === 0) return null
  const running = [...items].reverse().find(p => p.status !== 'done')
  return running || items[items.length - 1]
}

/** Compact "3 reads · 2 searches" mix for done Explored / subagent rows. */
export function summarizeToolSteps(steps) {
  const counts = {}
  for (const s of steps || []) {
    const n = s.name || 'other'
    let bucket = n
    if (n.endsWith('_fetch')) bucket = '__fetch__'
    else if (n.endsWith('_search') || n.endsWith('_web_search'))
      bucket = '__search__'
    counts[bucket] = (counts[bucket] || 0) + 1
  }
  const VERBS = [
    [READ, 'read', 'reads'],
    [GREP, 'search', 'searches'],
    [GLOB, 'glob', 'globs'],
    [LIST_DIR, 'dir', 'dirs'],
    ['list_directory', 'dir', 'dirs'],
    [BASH, 'cmd', 'cmds'],
    [POWERSHELL, 'cmd', 'cmds'],
    [WEB_SEARCH, 'web search', 'web searches'],
    ['__search__', 'web search', 'web searches'],
    [WEB_FETCH, 'fetch', 'fetches'],
    ['__fetch__', 'fetch', 'fetches'],
    [WRITE, 'write', 'writes'],
    [EDIT, 'edit', 'edits'],
    [SKILL, 'skill', 'skills'],
    [TOOL_SEARCH, 'tool search', 'tool searches'],
  ]
  const phrases = []
  for (const [key, sing, plur] of VERBS) {
    if (counts[key])
      phrases.push(`${counts[key]} ${counts[key] > 1 ? plur : sing}`)
  }
  if (phrases.length === 0) return null
  return phrases.join(' \u00B7 ')
}

export function detectToolError(part) {
  if (!part || part.status !== 'done') return false
  const r = part.result
  return typeof r === 'string' && r.startsWith('Error:')
}
