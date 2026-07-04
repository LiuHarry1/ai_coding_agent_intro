import React, { useState, useRef, useEffect } from 'react'
import DiffViewer from './DiffViewer.jsx'
import FilePreview from './FilePreview.jsx'
import CopyButton from './CopyButton.jsx'
import {
  fileName,
  formatDuration,
  formatBytes,
  detectError,
} from '../lib/utils.js'
import { useStreamingExpanded } from '../lib/use-streaming-expanded.js'

function toolIconClass(name) {
  if (name?.includes('edit')) return 'write'
  if (name?.includes('read') || name?.includes('fetch')) return 'read'
  if (name?.includes('write')) return 'write'
  if (
    name?.includes('bash') ||
    name?.includes('command') ||
    name?.includes('run')
  )
    return 'run'
  if (
    name?.includes('search') ||
    name?.includes('explore') ||
    name?.includes('plan') ||
    name?.includes('general')
  )
    return 'search'
  if (name?.includes('list')) return 'list'
  return 'default'
}

// Use a `$` shell-prompt glyph for bash so it doesn't collide visually with
// the chevron that toggles the card. (Old icon was `▶`, same as chevron →
// every bash card looked like "▶ ▶ bash …".)
const TOOL_ICONS = {
  read: '\u{1F4C4}',
  write: '\u270E',
  run: '$',
  search: '\u{1F50D}',
  list: '\u{1F4C1}',
  default: '\u2699',
}

const READ_ONLY_TOOLS = new Set([
  'Read',
  'list_dir',
  'list_directory',
  'search',
  'find',
  'Grep',
])

function isReadOnly(name) {
  if (READ_ONLY_TOOLS.has(name)) return true
  if (name?.startsWith('read') || name?.startsWith('list')) return true
  return false
}

function formatArgs(name, args) {
  if (!args) return ''
  if (args.file_path) return args.file_path
  if (args.path) return args.path
  if (args.command) return args.command
  // bash has 4 modes: run a command (above), check pid, kill pid, background.
  // Without this branch the mode-2/mode-3 calls render as raw JSON
  // (`bash {"pid":60090}`), which is gibberish to the user.
  if ((name === 'Bash' || name === 'PowerShell') && args.pid != null) {
    return args.kill ? `kill pid ${args.pid}` : `check pid ${args.pid}`
  }
  if (args.task)
    return args.task.slice(0, 80) + (args.task.length > 80 ? '\u2026' : '')
  if (args.query) return args.query
  if (args.pattern) return args.pattern
  if (args.directory) return args.directory
  return JSON.stringify(args).slice(0, 80)
}

function hasArgsContent(args) {
  return args && typeof args === 'object' && Object.keys(args).length > 0
}

function renderToolArgs(name, args) {
  if (!hasArgsContent(args)) return null
  if (name === 'Edit' && args.old_string != null && args.new_string != null) {
    return (
      <DiffViewer
        oldStr={args.old_string}
        newStr={args.new_string}
        filePath={args.file_path}
        replaceAll={args.replace_all}
      />
    )
  }
  if (name === 'Write' && typeof args.content === 'string') {
    return <FilePreview content={args.content} filePath={args.file_path} />
  }
  const json = JSON.stringify(args, null, 2)
  return (
    <div className='tool-args-wrap'>
      <CopyButton text={json} />
      <pre className='tool-args-json'>{json}</pre>
    </div>
  )
}

function StreamingArgs({ bytes, startTime }) {
  // Tick once a second so the elapsed counter keeps moving even if the
  // upstream pauses streaming bytes for a moment (which is exactly the
  // case we want visible — "still alive, model is thinking between
  // chunks").
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(n => n + 1), 1000)
    return () => clearInterval(id)
  }, [])

  const elapsed = startTime ? Math.round((Date.now() - startTime) / 1000) : 0

  return (
    <div className='tool-streaming-input'>
      <span className='spinner spinner-sm' />
      <span className='tool-streaming-input-label'>
        Generating arguments… {formatBytes(bytes)} ({elapsed}s)
      </span>
    </div>
  )
}

function LivePreview({ text, fileName, startTime }) {
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
    <div className='live-terminal live-preview'>
      <div className='live-terminal-header'>
        <span className='live-terminal-dot' />
        <span className='live-terminal-title'>
          {fileName ? `Writing ${fileName}…` : 'Writing…'}
        </span>
        <span className='live-preview-meta'>
          {formatBytes(bytes)} · {elapsed}s
        </span>
        <span className='spinner spinner-sm' />
      </div>
      <pre className='live-terminal-output' ref={ref}>
        {text || '(waiting…)'}
      </pre>
    </div>
  )
}

function LiveTerminal({ output, elapsed, done }) {
  const termRef = useRef(null)

  useEffect(() => {
    if (termRef.current) {
      termRef.current.scrollTop = termRef.current.scrollHeight
    }
  }, [output])

  return (
    <div className='live-terminal'>
      <div className='live-terminal-header'>
        <span className='live-terminal-dot' />
        <span className='live-terminal-title'>
          {done ? `Finished in ${elapsed}s` : `Running... ${elapsed}s`}
        </span>
        {!done && <span className='spinner spinner-sm' />}
      </div>
      <pre className='live-terminal-output' ref={termRef}>
        {output || '(waiting for output...)'}
      </pre>
    </div>
  )
}

export default function ToolCallCard({ part }) {
  const hasLiveOutput = part.liveOutput != null
  const name = part.name || ''
  const args = part.args || {}
  const result = part.result
  const isError = detectError(name, result)
  const isDone = part.status === 'done'
  const duration = formatDuration(part.duration)
  const hasLivePreview =
    !isDone &&
    typeof part.livePreview === 'string' &&
    part.livePreview.length > 0
  const cls = toolIconClass(name)
  const icon = TOOL_ICONS[cls] || TOOL_ICONS.default

  // Auto-expand strictly while the tool is running so the user sees the
  // streaming output live. Once finished (success or error) we collapse
  // to keep the conversation scannable — the user can click to re-open.
  const isStreaming = !isDone || hasLiveOutput || hasLivePreview
  const [expanded, toggleExpanded] = useStreamingExpanded(isStreaming)

  const truncLen = 3000
  const isLong = result && result.length > truncLen
  const [showFull, setShowFull] = useState(false)
  const displayResult = isLong && !showFull ? result.slice(0, truncLen) : result

  const filePath = args.file_path || args.path || null
  const fName = fileName(filePath)
  const argsPreview = formatArgs(name, args)
  const showArgsDetails = hasArgsContent(args) || hasLivePreview
  const showResultDetails = result != null && result !== ''

  return (
    <div
      className={`tool-card ${expanded ? 'open' : ''} ${isError ? 'has-error' : ''}`}
    >
      <div className='tool-card-header' onClick={toggleExpanded}>
        <span className='chevron'>{expanded ? '\u25BC' : '\u25B6'}</span>
        <span className={`tool-icon ${cls}`}>{icon}</span>
        <span className='tool-name'>{name}</span>
        {fName && (
          <span className='tool-file-badge' title={filePath}>
            {fName}
          </span>
        )}
        {!fName && argsPreview && (
          <span className='tool-args-preview' title={argsPreview}>
            {argsPreview}
          </span>
        )}
        <span className='tool-meta'>
          {!isDone && part.liveInputBytes != null && (
            <span className='tool-duration tool-duration--live'>
              {formatBytes(part.liveInputBytes)}
            </span>
          )}
          {part.liveElapsed && !isDone && (
            <span className='tool-duration tool-duration--live'>
              {part.liveElapsed}s
            </span>
          )}
          {duration && <span className='tool-duration'>{duration}</span>}
          {isDone ? (
            isError ? (
              <span className='tool-error-badge'>&#10007;</span>
            ) : (
              <span className='tool-check'>&#10003;</span>
            )
          ) : (
            <span className='spinner' />
          )}
        </span>
      </div>

      {expanded &&
        (showArgsDetails ||
          showResultDetails ||
          hasLivePreview ||
          hasLiveOutput ||
          (!isDone && part.liveInputBytes != null)) && (
          <div className='tool-card-body'>
            {hasLivePreview ? (
              <LivePreview
                text={part.livePreview}
                fileName={fName}
                startTime={part.liveInputStart}
              />
            ) : (
              !isDone &&
              part.liveInputBytes != null && (
                <StreamingArgs
                  bytes={part.liveInputBytes}
                  startTime={part.liveInputStart}
                />
              )
            )}

            {hasLiveOutput && !isDone && (
              <LiveTerminal
                output={part.liveOutput}
                elapsed={part.liveElapsed}
                done={part.liveDone}
              />
            )}

            {showArgsDetails && (
              <details open={name === 'Edit' || name === 'Write'}>
                <summary>Arguments</summary>
                {renderToolArgs(name, args)}
              </details>
            )}

            {showResultDetails && (
              <details open={isError} className={isError ? 'result-error' : ''}>
                <summary>
                  Result
                  {isError && (
                    <span className='result-error-label'>Failed</span>
                  )}
                  <span className='result-size'>
                    {formatBytes(result.length)}
                  </span>
                </summary>
                <div
                  className={`tool-result-wrap ${isError ? 'tool-result-wrap--error' : ''}`}
                >
                  <CopyButton text={result} />
                  <pre className='tool-result-pre'>{displayResult}</pre>
                  {isLong && (
                    <button
                      className='show-more-btn'
                      onClick={() => setShowFull(!showFull)}
                    >
                      {showFull
                        ? 'Show less'
                        : `Show all (${formatBytes(result.length)})`}
                    </button>
                  )}
                </div>
              </details>
            )}
          </div>
        )}
    </div>
  )
}
