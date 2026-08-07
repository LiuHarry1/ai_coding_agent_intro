import React, { useMemo } from 'react'
import ToolCallLine from './ToolCallLine.jsx'
import { detectError } from '../lib/utils.js'
import { useStreamingExpanded } from '../lib/use-streaming-expanded.js'

/**
 * ≈ Cursor awaitToolCall / Waiting→Waited (ShellToolCallView sibling).
 * details prefer elapsed duration ("briefly" / "1.2s"), fallback task id.
 * Expanded body shows shell output only — not the raw TaskOutput XML wrapper.
 */

function formatWaitDetails(part, taskId) {
  const ms =
    typeof part.duration === 'number'
      ? part.duration
      : typeof part.durationMs === 'number'
        ? part.durationMs
        : null
  if (ms === 0) return 'briefly'
  if (typeof ms === 'number' && ms > 0) {
    if (ms < 1000) return `${ms}ms`
    return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  }
  return taskId || ''
}

/** Strip TaskOutput XML envelope for UI; keep status for tooltip. */
function parseTaskOutputDisplay(raw) {
  if (typeof raw !== 'string' || !raw) {
    return { body: '', taskStatus: null, retrieval: null }
  }
  const retrieval = raw.match(/<retrieval_status>([^<]*)<\/retrieval_status>/)?.[1] ?? null
  const taskStatus = raw.match(/<status>([^<]*)<\/status>/)?.[1] ?? null
  const out = raw.match(/<output>\r?\n?([\s\S]*?)\r?\n?<\/output>/)
  const body = (out ? out[1] : raw).replace(/^\n+|\n+$/g, '')
  return { body, taskStatus, retrieval }
}

export default function TaskOutputCard({ part }) {
  const args = part.args || {}
  const taskId = args.task_id || args.shell_id || ''
  const result =
    part.toolUseResult?.text != null ? part.toolUseResult.text : part.result
  const isDone = part.status === 'done'
  const isError =
    isDone &&
    (part.isError === true ||
      detectError(part.name || 'TaskOutput', result) ||
      (typeof result === 'string' && result.startsWith('Error:')))

  const parsed = useMemo(() => parseTaskOutputDisplay(result), [result])
  const displayBody = parsed.body
  const hasOutput = typeof displayBody === 'string' && displayBody.length > 0

  const [expanded, toggleExpanded] = useStreamingExpanded(!isDone, {
    // Don't dump output into the transcript by default —
    // Cursor keeps Waited compact; expand only on errors.
    expandOnceWhen: isDone && isError,
  })

  // Cursor: action "Waiting" | "Waited"
  const action = !isDone ? 'Waiting' : isError ? 'Wait' : 'Waited'
  const details = isDone
    ? formatWaitDetails(part, taskId)
    : taskId || '…'

  const titleTooltip = [
    taskId,
    parsed.taskStatus ? `status: ${parsed.taskStatus}` : null,
    parsed.retrieval ? `retrieval: ${parsed.retrieval}` : null,
  ]
    .filter(Boolean)
    .join('\n')

  return (
    <div className={`tool-row task-output-card ${isError ? 'has-error' : ''}`}>
      <ToolCallLine
        expanded={expanded}
        onToggle={toggleExpanded}
        label={action}
        title={details || '…'}
        titlePlain
        titleTooltip={titleTooltip || details}
        duration={part.duration}
        isDone={isDone}
        isError={isError}
        showSuccess={isDone && !isError}
      />
      {expanded && hasOutput && (
        <pre
          className={`tool-row-body ui-shell-tool-call__output ${isError ? 'tool-row-body--error' : ''}`}
        >
          {displayBody}
        </pre>
      )}
      {expanded && isDone && !hasOutput && (
        <div className='tool-row-empty'>(no output)</div>
      )}
    </div>
  )
}
