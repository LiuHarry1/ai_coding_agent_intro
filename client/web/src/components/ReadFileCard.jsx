import React, { useState } from 'react'
import CopyButton from './CopyButton.jsx'
import ToolRowHeader from './ToolRowHeader.jsx'
import { fileName } from '../lib/utils.js'

/**
 * Single-row card for read_file. Mirrors the Cursor style:
 *   `▶ 📄 Read foo.tsx L1-105`
 *
 * Default-collapsed: read_file is the noisiest tool — letting it claim a
 * full code block per call buries the actual conversation.
 */

/** Tool returns `<path> (lines a-b of total)\n   N│code` or structured read output. */
function parseHeader(result) {
  if (typeof result !== 'string') return null
  const firstLine = result.split('\n', 1)[0] || ''
  const lineMatch = firstLine.match(/\(lines\s+(\d+)-(\d+)\s+of\s+(\d+)\)/)
  if (lineMatch) {
    return {
      kind: 'text',
      start: +lineMatch[1],
      end: +lineMatch[2],
      total: +lineMatch[3],
    }
  }
  if (firstLine.startsWith('[Image:'))
    return { kind: 'image', label: firstLine }
  if (firstLine.startsWith('[PDF:')) return { kind: 'pdf', label: firstLine }
  if (firstLine.match(/\(\d+ cells\)/))
    return { kind: 'notebook', label: firstLine }
  if (firstLine.startsWith('[PDF pages'))
    return { kind: 'pdf_pages', label: firstLine }
  return null
}

/** Drop the leading header line + the `   N│` gutter that read_file adds. */
function stripDecorations(result) {
  if (typeof result !== 'string') return ''
  const lines = result.split('\n')
  const body = lines[0]?.includes('(lines ') ? lines.slice(1) : lines
  return body.map(l => l.replace(/^\s*\d+│/, '')).join('\n')
}

export default function ReadFileCard({ part }) {
  const [expanded, setExpanded] = useState(false)
  const args = part.args || {}
  const result = part.result
  const isDone = part.status === 'done'
  const isError =
    isDone && typeof result === 'string' && result.startsWith('Error:')
  const filePath = args.file_path || args.path || null
  const fName = fileName(filePath) || filePath || '(unknown)'

  // Prefer the line range the tool actually returned; fall back to the
  // request args so we show *something* mid-flight.
  const header = parseHeader(result)
  let rangeLabel = ''
  if (header?.kind === 'text') {
    rangeLabel = `L${header.start}-${header.end}`
    if (header.total && header.end - header.start + 1 < header.total) {
      rangeLabel += ` of ${header.total}`
    }
  } else if (header?.kind === 'image') {
    rangeLabel = 'image'
  } else if (header?.kind === 'pdf' || header?.kind === 'pdf_pages') {
    rangeLabel = 'pdf'
  } else if (header?.kind === 'notebook') {
    rangeLabel = 'notebook'
  } else if (args.offset || args.limit) {
    const start = args.offset && args.offset > 0 ? args.offset : 1
    const end = args.limit ? start + args.limit - 1 : '?'
    rangeLabel = `L${start}-${end}`
  }

  const codeBody =
    isDone && !isError && header?.kind === 'text'
      ? stripDecorations(result)
      : ''
  const summaryBody =
    isDone && !isError && header && header.kind !== 'text' ? result : ''

  return (
    <div className={`tool-row read-file-card ${isError ? 'has-error' : ''}`}>
      <ToolRowHeader
        expanded={expanded}
        onToggle={() => setExpanded(v => !v)}
        label='Read'
        title={fName}
        titleTooltip={filePath || ''}
        subtitle={rangeLabel || null}
        duration={part.duration}
        isDone={isDone}
        isError={isError}
        actions={
          isDone && codeBody ? (
            <CopyButton text={codeBody} label='Copy' inline />
          ) : null
        }
      />

      {expanded && isDone && !isError && codeBody && (
        <pre className='tool-row-body'>{codeBody}</pre>
      )}
      {expanded && isDone && !isError && summaryBody && (
        <pre className='tool-row-body'>{summaryBody}</pre>
      )}
      {expanded && isError && (
        <div className='tool-row-body tool-row-body--error'>{result}</div>
      )}
    </div>
  )
}
