import React, { useState } from 'react'
import CopyButton from './CopyButton.jsx'
import ToolCallLine from './ToolCallLine.jsx'
import { liveToolSubtitle } from '../lib/tool-density.js'

/**
 * Single-row card for list_dir, mirroring ReadFileCard.
 * The tool's output ends with `\n(N files)`, which we parse for the
 * collapsed-state summary.
 */

function parseFileCount(result) {
  if (typeof result !== 'string') return null
  const m = result.match(/\((\d+)\s+files?\)\s*$/)
  return m ? +m[1] : null
}

export default function ListDirCard({ part }) {
  const [expanded, setExpanded] = useState(false)
  const args = part.args || {}
  const result = part.result
  const isDone = part.status === 'done'
  const isError =
    isDone && typeof result === 'string' && result.startsWith('Error:')

  const dirPath = args.dir_path || args.path || '.'
  const depth = args.depth
  const ignore =
    Array.isArray(args.ignore) && args.ignore.length > 0 ? args.ignore : null
  const fileCount = isDone && !isError ? parseFileCount(result) : null

  const meta = []
  if (depth != null) meta.push(`depth ${depth}`)
  if (ignore) meta.push(`ignore ${ignore.length}`)
  if (fileCount != null) meta.push(`${fileCount} files`)

  const liveSub = !isDone ? liveToolSubtitle(part) : null
  const subtitle =
    liveSub || (meta.length > 0 ? meta.join(' \u00B7 ') : null)

  return (
    <div className={`tool-row read-file-card ${isError ? 'has-error' : ''}`}>
      <ToolCallLine
        expanded={expanded}
        onToggle={() => setExpanded(v => !v)}
        label='LS'
        title={dirPath}
        titleTooltip={dirPath}
        subtitle={subtitle}
        duration={part.duration}
        isDone={isDone}
        isError={isError}
        actions={
          isDone && !isError && typeof result === 'string' ? (
            <CopyButton text={result} label='Copy' inline />
          ) : null
        }
      />

      {expanded && isDone && !isError && typeof result === 'string' && (
        <pre className='tool-row-body'>{result}</pre>
      )}
      {expanded && isError && (
        <div className='tool-row-body tool-row-body--error'>{result}</div>
      )}
    </div>
  )
}
