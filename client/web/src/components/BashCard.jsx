import React from 'react'
import CopyButton from './CopyButton.jsx'
import ToolCallLine from './ToolCallLine.jsx'
import LiveTerminal from './LiveTerminal.jsx'
import { detectError } from '../lib/utils.js'
import { useStreamingExpanded } from '../lib/use-streaming-expanded.js'
import { useChatStore } from '../stores/chat-store.js'
import { getTur } from '../lib/tool-result.js'
import { toolActionLabel } from '../lib/tool-action-labels.js'

/**
 * ≈ Cursor `ShellToolCallView` (`ui-shell-tool-call`):
 *   action: Running | Ran | Run(error) | Shell(backgrounded)
 *   details: description ?? "Running/Ran command" (not raw command by default)
 * Done body prefers TUR stdout/stderr; model `text` may include wrappers.
 */

function parseBackgroundTaskId(part) {
  const tur = getTur(part)
  if (typeof tur?.backgroundTaskId === 'string' && tur.backgroundTaskId) {
    return tur.backgroundTaskId
  }
  const text =
    typeof tur?.text === 'string'
      ? tur.text
      : typeof part.result === 'string'
        ? part.result
        : ''
  const m =
    text.match(/background with ID:\s*([a-z0-9]+)/i) ||
    text.match(/task_id:\s*([a-z0-9]+)/i)
  return m ? m[1] : null
}

/** Build display body from TUR fields; strip model wrappers. */
function shellDisplayParts(part) {
  const tur = getTur(part)
  if (tur) {
    const stdout = typeof tur.stdout === 'string' ? tur.stdout : ''
    const stderr = typeof tur.stderr === 'string' ? tur.stderr : ''
    const exitCode = tur.exitCode
    if (stdout || stderr || exitCode != null) {
      return { stdout, stderr, exitCode, textFallback: null }
    }
    if (typeof tur.text === 'string') {
      return { stdout: '', stderr: '', exitCode: null, textFallback: tur.text }
    }
  }
  if (typeof part.result === 'string') {
    return {
      stdout: '',
      stderr: '',
      exitCode: null,
      textFallback: part.result,
    }
  }
  return { stdout: '', stderr: '', exitCode: null, textFallback: null }
}

export default function BashCard({ part }) {
  const stopTool = useChatStore(s => s.stopSubagent)
  const args = part.args || {}
  const tur = getTur(part)
  const display = shellDisplayParts(part)
  const isDone = part.status === 'done'
  const modelText =
    typeof tur?.text === 'string'
      ? tur.text
      : typeof part.result === 'string'
        ? part.result
        : ''
  const isError =
    isDone &&
    (part.isError === true ||
      tur?.interrupted === true ||
      (typeof display.exitCode === 'number' && display.exitCode !== 0) ||
      detectError(part.name || 'Bash', modelText))

  const command = typeof args?.command === 'string' ? args.command.trim() : ''
  const description =
    typeof args?.description === 'string' ? args.description.trim() : ''
  // Cursor: prefer description; else generic phrase (not raw command in details)
  const details =
    description ||
    (!isDone ? 'Running command' : isError ? 'Run command' : 'Ran command')

  const wantsBackground = !!args.run_in_background
  const backgroundTaskId =
    isDone && !isError ? parseBackgroundTaskId(part) : null
  const isBackgrounded =
    !!backgroundTaskId ||
    tur?.backgrounded === true ||
    (wantsBackground && isDone && !isError)

  const action = toolActionLabel('shell', {
    loading: !isDone,
    hasError: isError,
    backgrounded: isBackgrounded,
  })

  const hasStructured =
    Boolean(display.stdout) ||
    Boolean(display.stderr) ||
    (display.exitCode != null && display.exitCode !== 0)
  const hasFallback =
    typeof display.textFallback === 'string' && display.textFallback.length > 0
  const hasOutput = hasStructured || hasFallback
  const hasLiveOutput = part.liveOutput != null
  const isRunning = !isDone

  const copyText = hasStructured
    ? [display.stdout, display.stderr ? `stderr:\n${display.stderr}` : '']
        .filter(Boolean)
        .join('\n')
    : display.textFallback || ''

  const [expanded, toggleExpanded] = useStreamingExpanded(
    isRunning && hasLiveOutput && !wantsBackground,
    {
      expandOnceWhen: isDone && !isBackgrounded && (isError || hasOutput),
    },
  )

  const showLive = expanded && hasLiveOutput && !isDone && !wantsBackground
  const showFinal = expanded && isDone && !isBackgrounded
  const titleTooltip =
    description && command && description !== command
      ? `${description}\n${command}`
      : command || details

  const onStop = e => {
    e.stopPropagation()
    if (isDone || part.stopping || !part.toolCallId) return
    void stopTool(part.toolCallId)
  }

  const exitBadge =
    isDone &&
    display.exitCode != null &&
    display.exitCode !== 0 ? (
      <span className='tool-row-meta-badge' title='Exit code'>
        exit {display.exitCode}
      </span>
    ) : null

  return (
    <div
      className={[
        'tool-row',
        'bash-card',
        'ui-shell-tool-call',
        isError ? 'has-error' : '',
        isRunning ? 'ui-shell-tool-call--pending' : '',
        isRunning ? 'ui-shell-tool-call--with-stop' : '',
        !isBackgrounded && (hasOutput || hasLiveOutput)
          ? 'ui-shell-tool-call--expandable'
          : '',
        isBackgrounded ? 'ui-shell-tool-call--backgrounded' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <ToolCallLine
        expanded={expanded}
        onToggle={isBackgrounded ? undefined : toggleExpanded}
        showChevron={!isBackgrounded}
        label={action}
        title={details}
        titlePlain
        titleTooltip={titleTooltip}
        subtitle={
          !isDone && part.liveElapsed != null ? `${part.liveElapsed}s` : null
        }
        meta={exitBadge}
        duration={isBackgrounded ? undefined : part.duration}
        isDone={isDone}
        isError={isError}
        showSuccess={isDone && !isError && !isBackgrounded}
        actions={
          <>
            {!isDone && part.toolCallId && (
              <button
                type='button'
                className='subagent-stop-btn ui-shell-tool-call__glass-stop'
                onClick={onStop}
                disabled={!!part.stopping}
                aria-label='Stop command'
              >
                {part.stopping ? 'Stopping…' : 'Stop'}
              </button>
            )}
            {isDone && !isError && hasOutput && !isBackgrounded ? (
              <CopyButton text={copyText} label='Copy output' inline />
            ) : null}
            {isDone && !isError && command ? (
              <CopyButton text={command} label='Copy command' inline />
            ) : null}
          </>
        }
      />

      {showLive && (
        <LiveTerminal
          output={part.liveOutput}
          elapsed={part.liveElapsed}
          done={false}
        />
      )}

      {showFinal && hasStructured && (
        <div className='ui-shell-tool-call__streams'>
          {display.stdout ? (
            <pre
              className={`tool-row-body ui-shell-tool-call__output ${isError ? 'tool-row-body--error' : ''}`}
            >
              {display.stdout}
            </pre>
          ) : null}
          {display.stderr ? (
            <pre className='tool-row-body tool-row-body--error ui-shell-tool-call__stderr'>
              {display.stderr}
            </pre>
          ) : null}
          {!display.stdout && !display.stderr && (
            <div className='tool-row-empty'>(no output)</div>
          )}
        </div>
      )}
      {showFinal && !hasStructured && hasFallback && (
        <pre
          className={`tool-row-body ui-shell-tool-call__output ${isError ? 'tool-row-body--error' : ''}`}
        >
          {display.textFallback}
        </pre>
      )}
      {showFinal && !hasOutput && (
        <div className='tool-row-empty'>(no output)</div>
      )}
    </div>
  )
}
