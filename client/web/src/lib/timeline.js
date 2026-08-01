/**
 * Assistant-turn timeline normalization (Cursor Composer–style).
 *
 * Store parts are raw; this module produces stable rows for rendering:
 *   parts → group consecutive tool_calls → workFold split → (view maps rows)
 *
 * Explored coalescing stays in tool-density.coalesceToolRuns — call it when
 * expanding a tool_group for display (see expandToolGroup).
 */

import { isPlanFileWrite } from './plan-utils.js'
import { SUPPRESSED_TOOL_CARDS } from './tool-names.js'
import { coalesceToolRuns, hasRunningSubagent } from './tool-density.js'

/** Part types allowed inside a collapsed turn work group. */
export const WORK_GROUP_CHILD_TYPES = new Set([
  'reasoning',
  'thinking',
  'tool_group',
  'todo_list',
  'compaction_start',
  'compaction_done',
])

/**
 * Merge consecutive tool_call parts into tool_group rows; pin plan_approval
 * to the end of the turn (after tools / questions).
 *
 * @param {object[]} parts
 * @returns {object[]}
 */
export function groupAssistantParts(parts) {
  const groupedParts = []
  const planParts = []
  let currentToolGroup = null

  for (const part of parts || []) {
    if (part.type === 'plan_approval') {
      currentToolGroup = null
      planParts.push(part)
      continue
    }
    if (part.type === 'tool_call') {
      if (!currentToolGroup) {
        currentToolGroup = { type: 'tool_group', items: [] }
        groupedParts.push(currentToolGroup)
      }
      currentToolGroup.items.push(part)
    } else {
      currentToolGroup = null
      groupedParts.push(part)
    }
  }
  groupedParts.push(...planParts)
  return groupedParts
}

/** @param {object} row grouped assistant part */
function isRowSettled(row) {
  switch (row?.type) {
    case 'reasoning':
      return row.status !== 'streaming'
    case 'thinking':
      // Ephemeral placeholder — keep outside the fold while visible.
      return false
    case 'tool_group':
      return (
        Array.isArray(row.items) &&
        row.items.length > 0 &&
        row.items.every(it => it.status === 'done')
      )
    case 'todo_list':
      return true
    case 'compaction_start':
      return false
    case 'compaction_done':
      return true
    default:
      return false
  }
}

/**
 * Whether a coalesceToolRuns entry is fully done (for in-group progressive fold).
 * @param {{ type: string, items?: object[], part?: object }} run
 */
export function isToolRunSettled(run) {
  if (!run) return false
  if (run.type === 'explored_run') {
    return (
      Array.isArray(run.items) &&
      run.items.length > 0 &&
      run.items.every(p => p.status === 'done')
    )
  }
  return run.part?.status === 'done'
}

/**
 * Split coalesced runs into a settled prefix + live suffix.
 * @param {ReturnType<typeof coalesceToolRuns>} runs
 */
export function splitSettledToolRuns(runs) {
  const list = runs || []
  let i = 0
  for (; i < list.length; i++) {
    if (!isToolRunSettled(list[i])) break
  }
  return { settled: list.slice(0, i), rest: list.slice(i) }
}

function foldStats(prefix) {
  let start = Infinity
  let end = -Infinity
  let runningTaskCount = 0
  for (const p of prefix) {
    if (p.type !== 'tool_group') continue
    for (const it of p.items || []) {
      if (typeof it.startTime === 'number') start = Math.min(start, it.startTime)
      if (typeof it.endTime === 'number') end = Math.max(end, it.endTime)
      if (it.isSubagent && it.status !== 'done') runningTaskCount++
    }
  }
  return {
    runningTaskCount,
    durationMs: end > start ? end - start : undefined,
  }
}

function countRunningTasks(rows) {
  let n = 0
  for (const p of rows || []) {
    if (p.type !== 'tool_group') continue
    for (const it of p.items || []) {
      if (it.isSubagent && it.status !== 'done') n++
    }
  }
  return n
}

/**
 * Turn-level work fold, mirroring Cursor's `workGroup` split.
 *
 * - Done turn: collapse every work row before the final assistant text.
 * - Streaming: collapse the longest settled work prefix when a live suffix
 *   (more tools, thinking, or answer text) follows — so completed search/read
 *   batches get out of the way while the agent keeps going.
 *
 * Bails out when the prefix holds a row that must stay visible
 * (questions, plan approval, errors).
 *
 * @param {object[]} rows grouped parts from groupAssistantParts
 * @param {boolean} streaming
 * @returns {null | { split: number, runningTaskCount: number, durationMs?: number }}
 */
export function computeWorkFold(rows, streaming) {
  let lastText = -1
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].type === 'text' && rows[i].content?.trim()) {
      lastText = i
      break
    }
  }

  if (!streaming) {
    if (lastText <= 0) return null
    const prefix = rows.slice(0, lastText)
    if (!prefix.every(p => WORK_GROUP_CHILD_TYPES.has(p.type))) return null
    const stats = foldStats(prefix)
    return {
      split: lastText,
      runningTaskCount: stats.runningTaskCount,
      durationMs: stats.durationMs,
    }
  }

  // Streaming: longest settled work prefix with something still visible after.
  let split = 0
  for (let i = 0; i < rows.length; i++) {
    const p = rows[i]
    if (p.type === 'text') break
    if (!WORK_GROUP_CHILD_TYPES.has(p.type)) break
    if (!isRowSettled(p)) break
    split = i + 1
  }
  if (split <= 0 || split >= rows.length) return null

  const prefix = rows.slice(0, split)
  if (!prefix.every(p => WORK_GROUP_CHILD_TYPES.has(p.type))) return null

  const stats = foldStats(prefix)
  return {
    split,
    // Prefer live tasks still open in the turn (usually the suffix).
    runningTaskCount: countRunningTasks(rows) || stats.runningTaskCount,
    durationMs: stats.durationMs,
  }
}

/**
 * Filter suppressed / plan-file writes, then coalesce explore runs.
 *
 * @param {object[]} items tool_call parts inside a tool_group
 * @returns {{ runs: ReturnType<typeof coalesceToolRuns>, waiting: boolean }}
 */
export function expandToolGroup(items) {
  const visibleItems = (items || []).filter(
    it =>
      it.type === 'tool_call' &&
      !SUPPRESSED_TOOL_CARDS.has(it.name) &&
      !isPlanFileWrite(it),
  )
  if (visibleItems.length === 0) {
    return { runs: [], waiting: false }
  }
  return {
    runs: coalesceToolRuns(visibleItems),
    waiting: hasRunningSubagent(visibleItems),
  }
}

/**
 * Full assistant-turn timeline for one message.
 *
 * @param {object[]} parts message.parts
 * @param {{ streaming?: boolean }} [options]
 * @returns {{ rows: object[], fold: ReturnType<typeof computeWorkFold> }}
 */
export function buildAssistantTimeline(parts, { streaming = false } = {}) {
  const rows = groupAssistantParts(parts)
  const fold = computeWorkFold(rows, streaming)
  return { rows, fold }
}
