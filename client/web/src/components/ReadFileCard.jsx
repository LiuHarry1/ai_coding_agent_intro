import React, { useMemo, useState } from 'react'
import CopyButton from './CopyButton.jsx'
import ToolCallLine from './ToolCallLine.jsx'
import { fileName } from '../lib/utils.js'
import { liveToolSubtitle } from '../lib/tool-density.js'
import { toolActionLabel, toolErrorDetails } from '../lib/tool-action-labels.js'

/**
 * Read card — CC dual-channel UI path:
 * body only from `part.toolUseResult`. Missing TUR → header-only (silent).
 *
 * Out stores raw file lines; line numbers exist only on the model map path.
 * `stripDecorations` remains for older sessions that still baked numbers into Out.
 */

function stripDecorations(content) {
  if (typeof content !== 'string') return ''
  const lines = content.split('\n')
  const body = lines[0]?.includes('(lines ') ? lines.slice(1) : lines
  return body.map(l => l.replace(/^\s*\d+│/, '')).join('\n')
}

function fromToolUseResult(tur) {
  if (!tur || typeof tur !== 'object' || typeof tur.type !== 'string') {
    return null
  }
  if (tur.type === 'file_unchanged') {
    return {
      kind: 'unchanged',
      label: 'Unchanged since last read',
    }
  }
  if (tur.type === 'text' && tur.file) {
    return {
      kind: 'text',
      start: tur.file.startLine,
      end: tur.file.startLine + (tur.file.numLines || 1) - 1,
      total: tur.file.totalLines,
      content: tur.file.content,
    }
  }
  if (tur.type === 'image') {
    return {
      kind: 'image',
      label: `[Image: ${tur.file?.filePath}, ${tur.file?.mediaType}]`,
    }
  }
  if (tur.type === 'pdf' || tur.type === 'pdf_pages') {
    return {
      kind: 'pdf',
      label:
        tur.type === 'pdf_pages'
          ? tur.file?.text || '[PDF pages]'
          : `[PDF: ${tur.file?.filePath}]`,
    }
  }
  if (tur.type === 'notebook') {
    return {
      kind: 'notebook',
      label: `${tur.file?.filePath} (${tur.file?.cells?.length ?? 0} cells)`,
      content: JSON.stringify(tur.file?.cells, null, 2),
    }
  }
  return null
}

export default function ReadFileCard({ part }) {
  const [expanded, setExpanded] = useState(false)
  const args = part.args || {}
  const result = part.result
  const isDone = part.status === 'done'
  const isError =
    isDone &&
    (part.isError === true ||
      (typeof result === 'string' && result.startsWith('Error:')))
  const filePath = args.file_path || args.path || null
  const fName = fileName(filePath) || filePath || '(unknown)'

  const header = useMemo(
    () => fromToolUseResult(part.toolUseResult),
    [part.toolUseResult],
  )

  let rangeLabel = ''
  if (header?.kind === 'text') {
    if (header.total === 0) {
      rangeLabel = 'empty'
    } else if (!header.content) {
      rangeLabel = `offset ${header.start} > ${header.total} lines`
    } else {
      rangeLabel = `L${header.start}-${header.end}`
      if (header.total && header.end - header.start + 1 < header.total) {
        rangeLabel += ` of ${header.total}`
      }
    }
  } else if (header?.kind === 'image') {
    rangeLabel = 'image'
  } else if (header?.kind === 'unchanged') {
    rangeLabel = 'unchanged'
  } else if (header?.kind === 'pdf') {
    rangeLabel = 'pdf'
  } else if (header?.kind === 'notebook') {
    rangeLabel = 'notebook'
  } else if (args.offset || args.limit) {
    const start = args.offset && args.offset > 0 ? args.offset : 1
    const end = args.limit ? start + args.limit - 1 : '?'
    rangeLabel = `L${start}-${end}`
  }

  const codeBody =
    isDone && !isError && header?.kind === 'text' && header.content
      ? stripDecorations(header.content)
      : ''
  // Empty / OOB text: no raw lines — show a short note instead of a blank expand.
  const emptyTextNote =
    isDone && !isError && header?.kind === 'text' && !header.content
      ? header.total === 0
        ? 'File exists but is empty.'
        : `Offset ${header.start} is past end of file (${header.total} lines).`
      : ''
  const summaryBody =
    isDone && !isError && header && header.kind !== 'text'
      ? header.content || header.label || ''
      : emptyTextNote

  const liveSub = !isDone ? liveToolSubtitle(part) : null
  const action = toolActionLabel('read', { loading: !isDone, hasError: isError })
  const title = isError ? toolErrorDetails(fName, true) : fName

  return (
    <div className={`tool-row read-file-card ${isError ? 'has-error' : ''}`}>
      <ToolCallLine
        expanded={expanded}
        onToggle={() => setExpanded(v => !v)}
        label={action}
        title={title}
        titleTooltip={filePath || ''}
        subtitle={liveSub || rangeLabel || null}
        duration={part.duration}
        isDone={isDone}
        isError={isError}
        showSuccess={isDone && !isError}
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
