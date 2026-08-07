import React from 'react'
import ToolCallLine from './ToolCallLine.jsx'
import { useStreamingExpanded } from '../lib/use-streaming-expanded.js'
import { getTur } from '../lib/tool-result.js'

/**
 * Compact row for ToolSearch — prefers TUR.matches list over model text dump.
 */
export default function ToolSearchCard({ part, nested = false }) {
  const args = part.args || {}
  const tur = getTur(part)
  const result = part.result
  const isDone = part.status === 'done'
  const isError =
    isDone && typeof result === 'string' && result.startsWith('Error:')

  const [expanded, toggleExpanded] = useStreamingExpanded(!nested && !isDone)

  const query =
    (typeof tur?.query === 'string' ? tur.query : null) ||
    (typeof args.query === 'string' ? args.query : '') ||
    ''
  const matches = Array.isArray(tur?.matches) ? tur.matches : null
  const title = query || 'ToolSearch\u2026'
  const hasMatches = matches && matches.length > 0
  const hasTextFallback =
    !hasMatches && typeof result === 'string' && result.trim()

  return (
    <div className={`tool-row tool-search-card ${isError ? 'has-error' : ''}`}>
      <ToolCallLine
        expanded={expanded}
        onToggle={toggleExpanded}
        showChevron={Boolean(
          isDone && !isError && (hasMatches || hasTextFallback),
        )}
        label='ToolSearch'
        title={title}
        titleTooltip={query || undefined}
        duration={part.duration}
        isDone={isDone}
        isError={isError}
      />

      {expanded && isDone && !isError && hasMatches && (
        <ul className='tool-row-body tool-search-matches'>
          {matches.map(m => (
            <li key={m.name}>
              <strong>{m.name}</strong>
              {m.description ? ` — ${m.description}` : ''}
            </li>
          ))}
        </ul>
      )}
      {expanded &&
        isDone &&
        !isError &&
        !hasMatches &&
        hasTextFallback && <pre className='tool-row-body'>{result}</pre>}
      {expanded && isError && (
        <div className='tool-row-body tool-row-body--error'>{result}</div>
      )}
    </div>
  )
}
