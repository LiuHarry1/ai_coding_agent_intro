import React, { useMemo } from 'react'
import CopyButton from './CopyButton.jsx'
import ToolCallLine from './ToolCallLine.jsx'
import { FileIcon } from './workspace-ide/icons.jsx'
import { useStreamingExpanded } from '../lib/use-streaming-expanded.js'
import { fileName, shortDisplayPath, truncateEnd } from '../lib/utils.js'

/**
 * Cursor-style Glob card — from `toolUseResult` only.
 */

function splitPathParts(filePath) {
  const norm = String(filePath || '').replace(/\\/g, '/')
  const base = fileName(norm) || norm
  const dir = norm.includes('/')
    ? norm.slice(0, norm.length - base.length).replace(/\/$/, '')
    : ''
  return { base, dir, full: norm }
}

function fromToolUseResult(tur) {
  if (!tur || typeof tur !== 'object') return null
  if (!Array.isArray(tur.filenames)) return null
  return {
    files: tur.filenames,
    truncated: !!tur.truncated,
    filteredCount: tur.filteredCount ?? 0,
    empty: tur.filenames.length === 0,
  }
}

export default function GlobCard({ part, nested = false }) {
  const args = part.args || {}
  const result = part.result
  const isDone = part.status === 'done'
  const isError =
    isDone &&
    (part.isError === true ||
      (typeof result === 'string' && result.startsWith('Error:')))

  const parsed = useMemo(
    () => fromToolUseResult(part.toolUseResult),
    [part.toolUseResult],
  )

  const hasBody =
    isError ||
    (!!parsed && (parsed.empty || parsed.files.length > 0))

  const [expanded, toggleExpanded] = useStreamingExpanded(!nested && !isDone, {
    expandOnceWhen:
      isDone &&
      ((isError && !!result) || (!!parsed && !parsed.empty)),
  })
  const showBody = expanded && hasBody

  const pattern = args.pattern || ''
  const displayPattern = pattern ? truncateEnd(pattern, 44) : ''
  const searchPath = args.path && args.path !== '.' ? args.path : null
  const displayPath = searchPath ? shortDisplayPath(searchPath) : null

  const subtitleParts = []
  if (displayPath) subtitleParts.push(displayPath)
  if (isDone && !isError && parsed && parsed.files.length > 0) {
    subtitleParts.push(
      `${parsed.files.length}${parsed.truncated ? '+' : ''} ${parsed.files.length === 1 ? 'file' : 'files'}`,
    )
  }

  const emptyHint =
    isDone && !isError && parsed?.empty ? 'No files matched' : null

  return (
    <div className={`tool-row glob-card ${isError ? 'has-error' : ''}`}>
      <ToolCallLine
        expanded={expanded && hasBody}
        onToggle={hasBody ? toggleExpanded : undefined}
        showChevron={hasBody}
        label='Glob'
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
          isDone && !isError && parsed && parsed.files.length > 0 ? (
            <CopyButton text={parsed.files.join('\n')} label='Copy' inline />
          ) : null
        }
      />

      {showBody && isDone && !isError && parsed && parsed.files.length > 0 && (
        <ul className='grep-results'>
          {parsed.files.map(f => {
            const parts = splitPathParts(f)
            return (
              <li key={f} className='grep-file-row' title={parts.full}>
                <span className='grep-path'>
                  <FileIcon size={12} />
                  <span className='grep-file-name'>{parts.base}</span>
                  {parts.dir ? (
                    <span className='grep-file-dir'>{parts.dir}</span>
                  ) : null}
                </span>
              </li>
            )
          })}
          {parsed.truncated && (
            <li className='glob-file-truncated'>
              Results truncated — narrow the pattern or path for more.
            </li>
          )}
        </ul>
      )}

      {showBody && isDone && !isError && parsed?.empty && (
        <div className='grep-empty'>No files matched</div>
      )}

      {showBody && isError && (
        <div className='tool-row-body tool-row-body--error'>{result}</div>
      )}
    </div>
  )
}
