import React from 'react'
import ToolCallLine from './ToolCallLine.jsx'
import { detectError } from '../lib/utils.js'
import { useStreamingExpanded } from '../lib/use-streaming-expanded.js'
import { getTur } from '../lib/tool-result.js'
import { toolActionLabel, toolErrorDetails } from '../lib/tool-action-labels.js'

/**
 * ≈ Cursor kill / stop background shell — compact action row.
 */
export default function TaskStopCard({ part }) {
  const args = part.args || {}
  const tur = getTur(part)
  const taskId = tur?.task_id || args.task_id || args.shell_id || ''
  const message =
    typeof tur?.message === 'string'
      ? tur.message
      : typeof tur?.text === 'string'
        ? tur.text
        : typeof part.result === 'string'
          ? part.result
          : ''
  const isDone = part.status === 'done'
  const isError =
    isDone &&
    (part.isError === true ||
      detectError(part.name || 'TaskStop', message) ||
      (typeof message === 'string' && message.startsWith('Error:')))
  const hasOutput = typeof message === 'string' && message.length > 0

  const [expanded, toggleExpanded] = useStreamingExpanded(false, {
    expandOnceWhen: isDone && isError,
  })

  const action = toolActionLabel('stop', {
    loading: !isDone,
    hasError: isError,
  })
  const title = isError
    ? toolErrorDetails(taskId || '…', true)
    : taskId || '…'

  return (
    <div className={`tool-row task-stop-card ${isError ? 'has-error' : ''}`}>
      <ToolCallLine
        expanded={expanded}
        onToggle={hasOutput || isError ? toggleExpanded : undefined}
        showChevron={Boolean(isDone && (hasOutput || isError))}
        label={action}
        title={title}
        titlePlain
        titleTooltip={taskId}
        duration={part.duration}
        isDone={isDone}
        isError={isError}
        showSuccess={isDone && !isError}
      />
      {expanded && hasOutput && (
        <pre
          className={`tool-row-body ${isError ? 'tool-row-body--error' : ''}`}
        >
          {message}
        </pre>
      )}
    </div>
  )
}
