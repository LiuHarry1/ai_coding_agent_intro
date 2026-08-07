/**
 * Assistant-turn timeline (Cursor default chat transcript).
 *
 * Matches `turn-work-grouping.js` / `U0m` (non-project presentation):
 *   - Incomplete / streaming turn → no workGroup; tools & thinking stay flat
 *   - Completed turn → wrap work before final assistant text as work_group
 *     with state.completed + durationMs → UI "Worked" + "for Ns"
 *
 * Expand state is keyed by stable `rowId` (≈ `expansionOverrides`).
 */

import { isPlanFileWrite } from './plan-utils.js'
import { SUPPRESSED_TOOL_CARDS } from './tool-names.js'
import { coalesceToolRuns, hasRunningSubagent } from './tool-density.js'

/** Part types Cursor allows inside a completed work_group (`sli`). */
export const WORK_GROUP_CHILD_TYPES = new Set([
  'reasoning',
  'thinking',
  'tool_group',
  'todo_list',
  'compaction_start',
  'compaction_done',
])

/**
 * Stable React key for a timeline row (including work_group).
 */
export function timelineRowKey(row, index) {
  if (!row) return `row-${index}`
  switch (row.type) {
    case 'work_group':
      return row.rowId || `work-group-${index}`
    case 'tool_group': {
      const first = row.items?.[0]?.toolCallId
      const last = row.items?.[row.items.length - 1]?.toolCallId
      if (first && last) return `tg-${first}-${last}`
      if (first) return `tg-${first}`
      return `tg-${index}-${row.items?.length ?? 0}`
    }
    case 'reasoning':
      return row.id ? `reasoning-${row.id}` : `reasoning-${row.startTime ?? index}`
    case 'thinking':
      return 'thinking'
    case 'text':
      return row.id ? `text-${row.id}` : `text-${index}`
    case 'todo_list':
      return `todo-${row.id ?? index}`
    case 'ask_user_question':
      return `ask-${row.id ?? index}`
    case 'plan_approval':
      return `plan-${row.id ?? index}`
    case 'compaction_start':
      return `compact-start-${index}`
    case 'compaction_done':
      return `compact-done-${index}`
    case 'error':
      return `error-${index}`
    default:
      return `${row.type || 'part'}-${index}`
  }
}

/** Stable key for a tool_call / explored member. */
export function toolPartKey(part, fallback = 'tool') {
  return part?.toolCallId || part?.id || fallback
}

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

/** Whether a coalesced tool run is fully done. */
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

function foldStats(children) {
  let start = Infinity
  let end = -Infinity
  let runningTaskCount = 0
  for (const p of children) {
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

/** Real work worth folding — not a lone Thinking placeholder. */
function hasFoldableWork(rows) {
  return (rows || []).some(p => {
    if (p.type === 'thinking') return false
    if (p.type === 'tool_group') return (p.items || []).length > 0
    if (p.type === 'reasoning') {
      return (
        !!(p.content && p.content.trim()) ||
        (p.duration != null && p.duration > 2)
      )
    }
    return WORK_GROUP_CHILD_TYPES.has(p.type)
  })
}

/**
 * Cursor `Q8c` / `g0m`: duration detail as "for Ns" (ceil to whole seconds).
 * @param {number} [ms]
 * @returns {string | undefined}
 */
export function formatWorkedDuration(ms) {
  if (ms == null || !(ms > 0)) return undefined
  const secs = Math.ceil(ms / 1000)
  if (ms < 1000) return 'for 1s'
  if (secs < 60) return `for ${secs}s`
  if (secs >= 3600) {
    const h = Math.floor(secs / 3600)
    const m = Math.floor((secs % 3600) / 60)
    return m > 0 ? `for ${h}h ${m}m` : `for ${h}h`
  }
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return s > 0 ? `for ${m}m ${s}s` : `for ${m}m`
}

/**
 * Cursor `U0m` completed path: one work_group before final assistant text.
 * `rowId` ≈ `work-group:${idPrefix}:${finalAssistantRowId}`.
 *
 * @param {object[]} children
 * @param {string} rowId
 * @param {string} [finalAssistantRowId]
 */
export function makeWorkGroupRow(children, rowId, finalAssistantRowId) {
  const stats = foldStats(children)
  return {
    type: 'work_group',
    rowId,
    state: 'completed',
    children,
    durationMs: stats.durationMs,
    runningTaskCount: stats.runningTaskCount,
    ...(finalAssistantRowId ? { finalAssistantRowId } : {}),
  }
}

/**
 * Cursor default-chat `U0m`:
 *   - streaming / incomplete → return rows as-is (no workGroup)
 *   - completed → fold work before final text
 *
 * @param {object[]} rows from groupAssistantParts
 * @param {{ streaming?: boolean, messageId?: string }} [options]
 * @returns {object[]}
 */
export function applyWorkGrouping(rows, { streaming = false, messageId = 'msg' } = {}) {
  const list = rows || []
  if (list.length === 0) return list

  // Cursor: `if (!e.completed) return raw work rows` — no Worked fold mid-stream.
  if (streaming) return list

  let lastText = -1
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].type === 'text' && list[i].content?.trim()) {
      lastText = i
      break
    }
  }
  // Cursor: need a final assistantMarkdown to anchor the fold.
  if (lastText <= 0) return list

  const prefix = list.slice(0, lastText)
  if (!prefix.every(p => WORK_GROUP_CHILD_TYPES.has(p.type))) return list
  if (!hasFoldableWork(prefix)) return list

  // Drop ephemeral thinking placeholders from a finished turn's fold body.
  const children = prefix.filter(p => p.type !== 'thinking')
  if (!hasFoldableWork(children)) return list

  const final = list[lastText]
  const finalId = final.id || String(lastText)
  const rowId = `work-group:${messageId}:${finalId}`
  return [
    makeWorkGroupRow(children, rowId, finalId),
    ...list.slice(lastText),
  ]
}

/**
 * @deprecated Prefer applyWorkGrouping.
 */
export function computeWorkFold(rows, streaming) {
  if (streaming) return null
  const list = rows || []
  let lastText = -1
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].type === 'text' && list[i].content?.trim()) {
      lastText = i
      break
    }
  }
  if (lastText <= 0) return null
  const prefix = list.slice(0, lastText).filter(p => p.type !== 'thinking')
  if (!prefix.every(p => WORK_GROUP_CHILD_TYPES.has(p.type))) return null
  if (!hasFoldableWork(prefix)) return null
  const stats = foldStats(prefix)
  return {
    split: lastText,
    runningTaskCount: stats.runningTaskCount,
    durationMs: stats.durationMs,
    state: 'completed',
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
 * @param {{ streaming?: boolean, messageId?: string }} [options]
 * @returns {{ rows: object[] }}
 */
export function buildAssistantTimeline(
  parts,
  { streaming = false, messageId } = {},
) {
  const grouped = groupAssistantParts(parts)
  const rows = applyWorkGrouping(grouped, {
    streaming,
    messageId: messageId || 'msg',
  })
  return { rows }
}
