import React from 'react'
import CopyButton from './CopyButton.jsx'
import ToolCallLine from './ToolCallLine.jsx'
import { formatBytes, detectError } from '../lib/utils.js'
import { formatMcpToolTitle } from '../lib/tool-kind.js'
import { useStreamingExpanded } from '../lib/use-streaming-expanded.js'

/**
 * Compact row for real MCP tool calls (never folded into Explored).
 * Cursor keeps these as their own rows with a clear server/tool label.
 */

function argHint(args) {
  if (!args || typeof args !== 'object') return null
  const keys = ['query', 'url', 'path', 'file_path', 'q', 'text', 'prompt']
  for (const k of keys) {
    const v = args[k]
    if (typeof v === 'string' && v.trim()) {
      const t = v.trim()
      return t.length > 64 ? `${t.slice(0, 61)}\u2026` : t
    }
  }
  try {
    const s = JSON.stringify(args)
    if (s === '{}' || s === 'null') return null
    return s.length > 64 ? `${s.slice(0, 61)}\u2026` : s
  } catch {
    return null
  }
}

export default function McpToolCard({ part, nested = false }) {
  const name = part.name || ''
  const args = part.args || {}
  const result = part.result
  const isDone = part.status === 'done'
  const isError = isDone && detectError(name, result)
  const hasBody = typeof result === 'string' && result.length > 0

  const [expanded, toggleExpanded] = useStreamingExpanded(!nested && !isDone)

  const title = formatMcpToolTitle(name)
  const hint = argHint(args)
  const sizeLabel =
    isDone && !isError && hasBody ? formatBytes(result.length) : null

  return (
    <div
      className={`tool-row mcp-tool-card ${nested ? 'tool-row--nested' : ''} ${isError ? 'has-error' : ''}`}
    >
      <ToolCallLine
        expanded={expanded}
        onToggle={toggleExpanded}
        showChevron={Boolean(isDone && (hasBody || isError))}
        label='MCP'
        title={title || '\u2026'}
        titleTooltip={name}
        subtitle={hint || undefined}
        meta={
          sizeLabel ? (
            <span className='tool-row-meta-badge' title='Result size'>
              {sizeLabel}
            </span>
          ) : null
        }
        duration={nested ? undefined : part.duration}
        isDone={isDone}
        isError={isError}
        actions={
          isDone && !isError && hasBody ? (
            <CopyButton text={result} label='Copy' inline />
          ) : null
        }
      />

      {expanded && isDone && !isError && hasBody && (
        <pre className='tool-row-body'>{result}</pre>
      )}
      {expanded && isError && (
        <div className='tool-row-body tool-row-body--error'>
          {typeof result === 'string' ? result : 'Error'}
        </div>
      )}
    </div>
  )
}
