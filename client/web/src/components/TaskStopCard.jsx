import React from 'react'
import ToolCallLine from './ToolCallLine.jsx'
import { detectError } from '../lib/utils.js'
import { useStreamingExpanded } from '../lib/use-streaming-expanded.js'

/**
 * ≈ Cursor kill / stop background shell — compact action row.
 */
export default function TaskStopCard({ part }) {
  const args = part.args || {}
  const taskId = args.task_id || args.shell_id || ''
  const result =
    part.toolUseResult?.text != null ? part.toolUseResult.text : part.result
  const isDone = part.status === 'done'
  const isError =
    isDone &&
    (part.isError === true ||
      detectError(part.name || 'TaskStop', result) ||
      (typeof result === 'string' && result.startsWith('Error:')))
  const hasOutput = typeof result === 'string' && result.length > 0

  const [expanded, toggleExpanded] = useStreamingExpanded(false, {
    expandOnceWhen: isDone && isError,
  })

  const action = !isDone ? 'Stopping' : isError ? 'Stop' : 'Stopped'

  return (
    <div className={`tool-row task-stop-card ${isError ? 'has-error' : ''}`}>
      <ToolCallLine
        expanded={expanded}
        onToggle={hasOutput || isError ? toggleExpanded : undefined}
        showChevron={Boolean(isDone && (hasOutput || isError))}
        label={action}
        title={taskId || '…'}
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
          {result}
        </pre>
      )}
    </div>
  )
}
