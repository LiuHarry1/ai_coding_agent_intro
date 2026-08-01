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

/**
 * Turn-level work fold, mirroring Cursor's `workGroup` split: once the turn
 * is done, every row before the final assistant message collapses behind one
 * header. Bails out when the prefix holds a row that must stay visible
 * (questions, plan approval, errors).
 *
 * @param {object[]} rows grouped parts from groupAssistantParts
 * @param {boolean} streaming
 * @returns {null | { split: number, runningTaskCount: number, durationMs?: number }}
 */
export function computeWorkFold(rows, streaming) {
  if (streaming) return null

  let lastText = -1
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].type === 'text' && rows[i].content?.trim()) {
      lastText = i
      break
    }
  }
  if (lastText <= 0) return null

  const prefix = rows.slice(0, lastText)
  if (!prefix.every(p => WORK_GROUP_CHILD_TYPES.has(p.type))) return null

  let start = Infinity
  let end = -Infinity
  let runningTaskCount = 0
  for (const p of prefix) {
    if (p.type !== 'tool_group') continue
    for (const it of p.items) {
      if (typeof it.startTime === 'number') start = Math.min(start, it.startTime)
      if (typeof it.endTime === 'number') end = Math.max(end, it.endTime)
      if (it.isSubagent && it.status !== 'done') runningTaskCount++
    }
  }

  return {
    split: lastText,
    runningTaskCount,
    durationMs: end > start ? end - start : undefined,
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
