import React from 'react'
import ToolRowHeader from './ToolRowHeader.jsx'
import { useStreamingExpanded } from '../lib/use-streaming-expanded.js'

/**
 * Compact row for ToolSearch — avoids the generic ToolCallCard's bulky
 * Arguments/Result panels for a one-field lookup tool.
 */
export default function ToolSearchCard({ part }) {
  const args = part.args || {}
  const result = part.result
  const isDone = part.status === 'done'
  const isError =
    isDone && typeof result === 'string' && result.startsWith('Error:')

  const [expanded, toggleExpanded] = useStreamingExpanded(!isDone)

  const query = typeof args.query === 'string' ? args.query : ''
  const title = query || 'ToolSearch\u2026'

  return (
    <div className={`tool-row tool-search-card ${isError ? 'has-error' : ''}`}>
      <ToolRowHeader
        expanded={expanded}
        onToggle={toggleExpanded}
        showChevron={Boolean(isDone && result && !isError)}
        label='ToolSearch'
        title={title}
        titleTooltip={query || undefined}
        duration={part.duration}
        isDone={isDone}
        isError={isError}
      />

      {expanded &&
        isDone &&
        !isError &&
        typeof result === 'string' &&
        result.trim() && <pre className='tool-row-body'>{result}</pre>}
      {expanded && isError && (
        <div className='tool-row-body tool-row-body--error'>{result}</div>
      )}
    </div>
  )
}
