import React, { useState } from 'react'
import CopyButton from './CopyButton.jsx'
import ToolChrome from './ToolChrome.jsx'
import { detectError, fileName, formatBytes } from '../lib/utils.js'

/** One-line title for unknown nested tools — never inline JSON in the header. */
function nestedStepTitle(name, args) {
  if (!args || typeof args !== 'object') return ''
  if (typeof args.description === 'string' && args.description.trim()) {
    const t = args.description.trim()
    return t.length > 80 ? `${t.slice(0, 80)}\u2026` : t
  }
  if (typeof args.query === 'string') return args.query
  if (typeof args.command === 'string') {
    const c = args.command.trim()
    return c.length > 80 ? `${c.slice(0, 80)}\u2026` : c
  }
  if (args.file_path || args.path) {
    return fileName(args.file_path || args.path) || args.file_path || args.path
  }
  if (typeof args.pattern === 'string') return args.pattern
  if (typeof args.skill_name === 'string') return args.skill_name
  const keys = Object.keys(args)
  if (keys.length === 1 && typeof args[keys[0]] === 'string') {
    const v = args[keys[0]].trim()
    return v.length > 80 ? `${v.slice(0, 80)}\u2026` : v
  }
  return ''
}

/**
 * Compact fallback for nested subagent steps that lack a dedicated card.
 * Avoids the bulky ToolCallCard Arguments/Result panels inside Explore.
 */
export default function SubagentStepFallback({ part }) {
  const [expanded, setExpanded] = useState(false)
  const name = part.name || 'tool'
  const args = part.args || {}
  const result = part.result
  const isDone = part.status === 'done'
  const isError = isDone && detectError(name, result)
  const title = nestedStepTitle(name, args)
  const hasBody = typeof result === 'string' && result.length > 0
  const sizeLabel =
    isDone && !isError && hasBody ? formatBytes(result.length) : null

  return (
    <ToolChrome
      variant='subagent-step-fallback'
      nested
      isError={isError}
      isDone={isDone}
      expanded={expanded}
      onToggle={() => setExpanded(v => !v)}
      hasBody={Boolean(isDone && hasBody)}
      showChevron={Boolean(isDone && hasBody)}
      label={name}
      title={title || '\u2026'}
      titleTooltip={title || undefined}
      meta={
        sizeLabel ? (
          <span className='tool-row-meta-badge' title='Result size'>
            {sizeLabel}
          </span>
        ) : null
      }
    >
      {isDone && !isError && hasBody && (
        <pre className='tool-row-body'>{result}</pre>
      )}
      {isError && (
        <div className='tool-row-body tool-row-body--error'>{result}</div>
      )}
      {isDone && !isError && hasBody && (
        <div className='tool-row-actions-bar'>
          <CopyButton text={result} label='Copy result' inline />
        </div>
      )}
    </ToolChrome>
  )
}
