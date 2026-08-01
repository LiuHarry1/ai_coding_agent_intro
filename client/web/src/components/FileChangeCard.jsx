import React, { useState, useEffect, useRef } from 'react'
import DiffViewer from './DiffViewer.jsx'
import FilePreview from './FilePreview.jsx'
import CopyButton from './CopyButton.jsx'
import {
  fileName,
  formatDuration,
  formatBytes,
  shortDisplayPath,
} from '../lib/utils.js'

/**
 * File-centric card for Write / Edit (Cursor edit chrome):
 * verb + path + +/- counts, expandable preview/diff.
 */

function LivePreviewInline({ text, startTime }) {
  const ref = useRef(null)
  const [, setTick] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setTick(n => n + 1), 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [text])

  const elapsed = startTime ? Math.round((Date.now() - startTime) / 1000) : 0
  const bytes = text?.length ?? 0

  return (
    <div className='file-change-live'>
      <div className='file-change-live-meta'>
        Writing… {formatBytes(bytes)} · {elapsed}s
      </div>
      <pre className='file-change-live-code' ref={ref}>
        {text || ''}
      </pre>
    </div>
  )
}

/**
 * Count line-level additions/removals between two strings. Mirrors the
 * "+N -M" badges shown by Cursor / Continue diff cards.
 */
function diffLineCounts(oldStr, newStr) {
  const oldLines = (oldStr ?? '').split('\n').length
  const newLines = (newStr ?? '').split('\n').length
  const removed = oldLines - (oldStr === '' ? 1 : 0)
  const added = newLines - (newStr === '' ? 1 : 0)
  return { added: Math.max(added, 0), removed: Math.max(removed, 0) }
}

/**
 * Inline counts after the path (e.g. `+12` / `+3 -1`).
 */
function ChangeBadge({ kind, args }) {
  if (kind === 'write') {
    const content = args?.content ?? ''
    if (!content) return null
    const lines = content.split('\n').length
    const visible = content.endsWith('\n') ? lines - 1 : lines
    if (visible <= 0) return null
    return (
      <span className='file-change-count file-change-count--add'>
        +{visible}
      </span>
    )
  }
  if (kind === 'edit') {
    const { added, removed } = diffLineCounts(
      args?.old_string,
      args?.new_string,
    )
    if (added === 0 && removed === 0) return null
    return (
      <span className='file-change-count'>
        {added > 0 && <span className='file-change-count--add'>+{added}</span>}
        {added > 0 && removed > 0 && ' '}
        {removed > 0 && (
          <span className='file-change-count--remove'>-{removed}</span>
        )}
      </span>
    )
  }
  return null
}

const ALWAYS_OPEN_LINE_THRESHOLD = 8
const COLLAPSED_PREVIEW_LINES = 4

function ContentPreview({ text }) {
  const lines = (text || '').split('\n').slice(0, COLLAPSED_PREVIEW_LINES)
  return <pre className='file-change-collapsed-preview'>{lines.join('\n')}</pre>
}

function FileChangeStub({
  name,
  isDone,
  isError,
  result,
  duration,
  liveInputBytes,
  nested,
}) {
  let status
  if (!isDone) {
    const sizeLabel =
      liveInputBytes != null && liveInputBytes > 0
        ? formatBytes(liveInputBytes)
        : 'preparing…'
    status = (
      <>
        <span className='file-change-stub-meta'>{sizeLabel}</span>
        <span className='spinner spinner-sm' />
      </>
    )
  } else {
    status = (
      <>
        {duration && <span className='file-change-stub-meta'>{duration}</span>}
        <span className='file-change-status file-change-status--error'>
          {'\u2717'}
        </span>
      </>
    )
  }
  return (
    <div
      className={`file-change-stub ${isError ? 'has-error' : ''} ${nested ? 'file-change-stub--nested' : ''}`}
    >
      <div className='file-change-stub-row'>
        <span className='file-change-stub-verb'>
          {isDone ? 'Edit' : 'Editing'}
        </span>
        <span className='file-change-stub-name'>{name || 'tool_call'}</span>
        <span className='file-change-stub-label'>
          {isDone ? 'missing file_path' : 'preparing arguments'}
        </span>
        <span className='file-change-stub-spacer' />
        {status}
      </div>
      {isDone && isError && typeof result === 'string' && (
        <div className='file-change-stub-error'>{result}</div>
      )}
    </div>
  )
}

export default function FileChangeCard({ part, nested = false }) {
  const name = part.name || ''
  const args = part.args || {}
  const result = part.result
  const isDone = part.status === 'done'
  const isError =
    isDone && typeof result === 'string' && result.startsWith('Error:')
  const duration = formatDuration(part.duration)
  const filePath = args.file_path || args.path || null
  const isWrite = name === 'Write' || name === 'write_file'
  const kind = isWrite ? 'write' : 'edit'
  const verb = isDone
    ? isWrite
      ? 'Created'
      : 'Edited'
    : isWrite
      ? 'Creating'
      : 'Editing'
  const hasLivePreview =
    !isDone &&
    typeof part.livePreview === 'string' &&
    part.livePreview.length > 0

  const hasArgsContent =
    (isWrite
      ? typeof args.content === 'string' && args.content.length > 0
      : false) ||
    (!isWrite &&
      (typeof args.new_string === 'string' ||
        typeof args.old_string === 'string'))
  const hasAnythingToShow = hasLivePreview || hasArgsContent
  if (!filePath && !hasAnythingToShow) {
    return (
      <FileChangeStub
        name={name}
        isDone={isDone}
        isError={isError || isDone}
        result={result}
        duration={duration}
        liveInputBytes={part.liveInputBytes}
        nested={nested}
      />
    )
  }

  const displayPath =
    (filePath && shortDisplayPath(filePath)) ||
    fileName(filePath) ||
    filePath ||
    (isDone ? '(missing file_path)' : 'writing…')

  // Badge args: prefer final content; while streaming a write, use livePreview.
  const badgeArgs =
    isWrite && !args.content && hasLivePreview
      ? { content: part.livePreview }
      : args

  const previewSource = isWrite
    ? args.content || (hasLivePreview ? part.livePreview : null)
    : args.new_string
  const changedLineCount = previewSource
    ? (previewSource.match(/\n/g)?.length ?? 0) + 1
    : 0
  const shouldAutoExpand =
    !isDone ||
    hasLivePreview ||
    isError ||
    (!nested && changedLineCount <= ALWAYS_OPEN_LINE_THRESHOLD)
  const [expanded, setExpanded] = useState(shouldAutoExpand)
  const [userToggled, setUserToggled] = useState(false)
  useEffect(() => {
    if (!userToggled) setExpanded(shouldAutoExpand)
  }, [shouldAutoExpand, userToggled])

  let body = null
  let copyText = null
  let extraMeta = null
  if (hasLivePreview) {
    body = (
      <LivePreviewInline
        text={part.livePreview}
        startTime={part.liveInputStart}
      />
    )
  } else if (isWrite && typeof args.content === 'string') {
    body = <FilePreview content={args.content} filePath={filePath} embedded />
    copyText = args.content
    const lines = args.content.split('\n')
    const visible = args.content.endsWith('\n')
      ? lines.length - 1
      : lines.length
    extraMeta = `${visible} lines`
  } else if (
    !isWrite &&
    typeof args.old_string === 'string' &&
    typeof args.new_string === 'string'
  ) {
    body = (
      <DiffViewer
        oldStr={args.old_string}
        newStr={args.new_string}
        filePath={filePath}
        replaceAll={args.replace_all}
        embedded
      />
    )
    copyText = args.new_string
    if (args.replace_all) extraMeta = 'replace all'
  }

  const toggle = () => {
    setUserToggled(true)
    setExpanded(v => !v)
  }
  const stop = e => e.stopPropagation()

  return (
    <div
      className={`file-change-card file-change-card--${kind} ${isError ? 'has-error' : ''} ${nested ? 'file-change-card--nested' : ''}`}
    >
      <button
        type='button'
        className='file-change-header'
        onClick={toggle}
        aria-expanded={expanded}
      >
        <span
          className={`file-change-chevron ${expanded ? 'open' : ''}`}
          aria-hidden='true'
        >
          {'\u25B6'}
        </span>
        <span className='file-change-verb'>{verb}</span>
        <span className='file-change-name' title={filePath || ''}>
          {displayPath}
        </span>
        <ChangeBadge kind={kind} args={badgeArgs} />
        {extraMeta && isDone && (
          <span className='file-change-extra-meta'>{extraMeta}</span>
        )}
        <span className='file-change-spacer' />
        {!isDone && part.liveInputBytes != null && !hasLivePreview && (
          <span className='file-change-progress'>
            {formatBytes(part.liveInputBytes)}
          </span>
        )}
        {duration && isDone && (
          <span className='file-change-duration'>{duration}</span>
        )}
        {isDone && copyText != null && (
          <span onClick={stop}>
            <CopyButton text={copyText} label='Copy' inline />
          </span>
        )}
        {isDone ? (
          isError ? (
            <span className='file-change-status file-change-status--error'>
              {'\u2717'}
            </span>
          ) : (
            <span className='file-change-status file-change-status--ok'>
              {'\u2713'}
            </span>
          )
        ) : (
          <span className='spinner spinner-sm' />
        )}
      </button>

      {expanded && body && <div className='file-change-body'>{body}</div>}
      {!expanded && isDone && previewSource && (
        <div
          className='file-change-body file-change-body--truncated'
          onClick={toggle}
        >
          <ContentPreview text={previewSource} />
        </div>
      )}

      {isError && <div className='file-change-error'>{result}</div>}
    </div>
  )
}
