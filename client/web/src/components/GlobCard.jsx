import React, { useMemo } from 'react'
import CopyButton from './CopyButton.jsx'
import ToolRowHeader from './ToolRowHeader.jsx'
import { useStreamingExpanded } from '../lib/use-streaming-expanded.js'
import { shortDisplayPath, truncateEnd } from '../lib/utils.js'

/**
 * Cursor-style card for the `glob` tool.
 *
 * Header shape:
 *   Searched files   "**\/*.ts"   src/   · 12 files
 *
 * Glob result string (see examples/08-basic/tools/glob.ts:execute) is either:
 *   - "No files found"
 *   - <relative path>\n<relative path>\n…   (optionally followed by
 *     a trailing "(Results are truncated…)" hint line)
 *   - "Error: …"
 */

const TRUNC_HINT = '(Results are truncated'

function parseResult(result) {
  if (typeof result !== 'string')
    return { files: [], truncated: false, empty: false }
  if (result.startsWith('Error:'))
    return { files: [], truncated: false, empty: false }
  if (result.trim() === 'No files found') {
    return { files: [], truncated: false, empty: true }
  }
  const lines = result.split('\n').filter(Boolean)
  let truncated = false
  const files = []
  for (const line of lines) {
    if (line.startsWith(TRUNC_HINT)) {
      truncated = true
      continue
    }
    files.push(line)
  }
  return { files, truncated, empty: false }
}

export default function GlobCard({ part }) {
  const args = part.args || {}
  const result = part.result
  const isDone = part.status === 'done'
  const isError =
    isDone && typeof result === 'string' && result.startsWith('Error:')

  const { files, truncated, empty } = useMemo(
    () => parseResult(result),
    [result],
  )

  // Expanded only while running (to stream results); collapses on done.
  const [expanded, toggleExpanded] = useStreamingExpanded(!isDone)

  const pattern = args.pattern || ''
  const displayPattern = pattern ? truncateEnd(pattern, 44) : ''
  const searchPath = args.path && args.path !== '.' ? args.path : null
  const displayPath = searchPath ? shortDisplayPath(searchPath) : null

  const subtitleParts = []
  if (displayPath) subtitleParts.push(displayPath)
  if (isDone && !isError && files.length > 0) {
    subtitleParts.push(
      `${files.length}${truncated ? '+' : ''} ${files.length === 1 ? 'file' : 'files'}`,
    )
  }

  const emptyHint = isDone && !isError && empty ? 'No files matched' : null

  return (
    <div className={`tool-row glob-card ${isError ? 'has-error' : ''}`}>
      <ToolRowHeader
        expanded={expanded}
        onToggle={toggleExpanded}
        showChevron={false}
        label='Searched files'
        title={displayPattern ? `\u201C${displayPattern}\u201D` : 'glob\u2026'}
        titleTooltip={pattern}
        subtitle={
          subtitleParts.length > 0 ? subtitleParts.join(' \u00B7 ') : null
        }
        subtitleTooltip={searchPath || undefined}
        duration={part.duration}
        isDone={isDone}
        isError={isError}
        emptyHint={emptyHint}
        actions={
          isDone && !isError && files.length > 0 ? (
            <CopyButton text={files.join('\n')} label='Copy' inline />
          ) : null
        }
      />

      {expanded && isDone && !isError && files.length > 0 && (
        <ul className='glob-file-list'>
          {files.map(f => (
            <li key={f} className='glob-file-item' title={f}>
              <span className='glob-file-icon' aria-hidden='true'>
                {'\u{1F4C4}'}
              </span>
              <span className='glob-file-path'>{f}</span>
            </li>
          ))}
          {truncated && (
            <li className='glob-file-truncated'>
              Results truncated — narrow the pattern or path for more.
            </li>
          )}
        </ul>
      )}

      {expanded && isDone && !isError && empty && (
        <div className='tool-row-body'>
          No files matched <code>{pattern}</code>.
        </div>
      )}

      {expanded && isError && (
        <div className='tool-row-body tool-row-body--error'>{result}</div>
      )}
    </div>
  )
}
