import React, { useMemo } from 'react'
import ToolCallLine from './ToolCallLine.jsx'
import { detectError } from '../lib/utils.js'
import { useStreamingExpanded } from '../lib/use-streaming-expanded.js'
import { getTur } from '../lib/tool-result.js'
import { toolActionLabel } from '../lib/tool-action-labels.js'

/**
 * ≈ Cursor awaitToolCall / Waiting→Waited.
 * Body prefers TUR.output; model text may include XML wrappers.
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

export default function TaskOutputCard({ part }) {
  const args = part.args || {}
  const tur = getTur(part)
  const taskId = tur?.task_id || args.task_id || args.shell_id || ''
  const result =
    typeof tur?.text === 'string' ? tur.text : part.result
  const isDone = part.status === 'done'
  const isError =
    isDone &&
    (part.isError === true ||
      detectError(part.name || 'TaskOutput', result) ||
      (typeof result === 'string' && result.startsWith('Error:')) ||
      tur?.retrieval_status === 'timeout')

  const displayBody = useMemo(() => {
    if (typeof tur?.output === 'string') return tur.output
    if (typeof result !== 'string' || !result) return ''
    const out = result.match(/<output>\r?\n?([\s\S]*?)\r?\n?<\/output>/)
    return (out ? out[1] : result).replace(/^\n+|\n+$/g, '')
  }, [tur, result])

  const hasOutput = typeof displayBody === 'string' && displayBody.length > 0
  const retrieval = tur?.retrieval_status ?? null
  const taskStatus = tur?.task_status ?? null

  const [expanded, toggleExpanded] = useStreamingExpanded(!isDone, {
    expandOnceWhen: isDone && isError,
  })

  const action = toolActionLabel('await', {
    loading: !isDone,
    hasError: isError,
  })
  const details = isDone ? formatWaitDetails(part, taskId) : taskId || '…'

  const titleTooltip = [
    taskId,
    taskStatus ? `status: ${taskStatus}` : null,
    retrieval ? `retrieval: ${retrieval}` : null,
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
