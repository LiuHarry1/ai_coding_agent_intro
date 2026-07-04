import React, { useState } from 'react'
import CopyButton from './CopyButton.jsx'
import { fileName } from '../lib/utils.js'

const COLLAPSED_LINES = 30

/**
 * Read-only viewer for a file's full contents. Used by tools that produce
 * one whole-file blob (write_file). Mirrors DiffViewer's header/typography
 * so a write_file card and an edit_file card look consistent.
 *
 * Layout: header bar (icon + filename + line/char counts + copy button)
 * over a two-column body (right-aligned line-number gutter + monospace
 * pre with horizontal scroll). Files longer than COLLAPSED_LINES start
 * collapsed with a "Show all N lines" toggle so a 500-line file doesn't
 * dominate the chat.
 */
/**
 * Set `embedded` when rendering inside another card (e.g. FileChangeCard)
 * that already shows the filename + copy button. We then suppress our own
 * header to avoid the duplicated "📄 file.md  📄 file.md" stack.
 */
export default function FilePreview({ content, filePath, embedded = false }) {
  const [expanded, setExpanded] = useState(false)
  const text = content || ''
  const fName = fileName(filePath)
  const lines = text.split('\n')
  const lastIsEmpty = lines.length > 0 && lines[lines.length - 1] === ''
  const visibleCount = lastIsEmpty ? lines.length - 1 : lines.length
  const charCount = text.length

  const isLong = visibleCount > COLLAPSED_LINES
  const sliceLen = isLong && !expanded ? COLLAPSED_LINES : visibleCount
  const codeShown = lines.slice(0, sliceLen).join('\n')
  const gutterShown = Array.from({ length: sliceLen }, (_, i) => i + 1).join(
    '\n',
  )

  return (
    <div className={`file-preview ${embedded ? 'file-preview--embedded' : ''}`}>
      {!embedded && filePath && (
        <div className='file-preview-header'>
          <span className='diff-file-icon'>{'\u{1F4C4}'}</span>
          <span className='diff-file-name' title={filePath}>
            {fName || filePath}
          </span>
          <span className='file-preview-meta'>
            {visibleCount.toLocaleString()} lines · {charCount.toLocaleString()}{' '}
            chars
          </span>
          <CopyButton text={text} label='Copy content' inline />
        </div>
      )}
      <div className='file-preview-body'>
        <pre className='file-preview-gutter' aria-hidden='true'>
          {gutterShown}
        </pre>
        <pre className='file-preview-code'>{codeShown}</pre>
      </div>
      {isLong && (
        <button
          type='button'
          className='file-preview-toggle'
          onClick={() => setExpanded(v => !v)}
        >
          {expanded
            ? `Collapse — show first ${COLLAPSED_LINES} lines`
            : `Show all ${visibleCount.toLocaleString()} lines (${visibleCount - COLLAPSED_LINES} more)`}
        </button>
      )}
    </div>
  )
}
