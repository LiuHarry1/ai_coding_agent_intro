import React from 'react'
import CopyButton from './CopyButton.jsx'
import ToolCallLine from './ToolCallLine.jsx'
import LiveTerminal from './LiveTerminal.jsx'
import { detectError } from '../lib/utils.js'
import { useStreamingExpanded } from '../lib/use-streaming-expanded.js'
import { useChatStore } from '../stores/chat-store.js'

/**
 * ≈ Cursor `ShellToolCallView` (`ui-shell-tool-call`):
 *   action: Running | Ran | Run(error) | Shell(backgrounded)
 *   details: description ?? command
 * Backgrounded rows stay compact — live terminal lives in
 * `background-terminals` (ComposerTerminalService), not an agent-hint banner.
 */

function parseBackgroundTaskId(part) {
  const fromData = part.toolUseResult?.backgroundTaskId
  if (typeof fromData === 'string' && fromData) return fromData
  const text =
    typeof part.toolUseResult?.text === 'string'
      ? part.toolUseResult.text
      : typeof part.result === 'string'
        ? part.result
        : ''
  const m =
    text.match(/background with ID:\s*([a-z0-9]+)/i) ||
    text.match(/task_id:\s*([a-z0-9]+)/i)
  return m ? m[1] : null
}

function shellAction({ isDone, isError, isBackgrounded }) {
  // Cursor jlm(): pending → "Running", else "Ran"
  // Explored / backgrounded shellToolCall → action "Shell"
  if (!isDone) return 'Running'
  if (isError) return 'Run'
  if (isBackgrounded) return 'Shell'
  return 'Ran'
}

export default function BashCard({ part }) {
  const stopTool = useChatStore(s => s.stopSubagent)
  const args = part.args || {}
  const result =
    part.toolUseResult?.text != null ? part.toolUseResult.text : part.result
  const isDone = part.status === 'done'
  const isError =
    isDone &&
    (part.isError === true ||
      part.toolUseResult?.interrupted === true ||
      detectError(part.name || 'Bash', result))

  const command = typeof args?.command === 'string' ? args.command.trim() : ''
  const description =
    typeof args?.description === 'string' ? args.description.trim() : ''
  // Cursor: T7r(n.description ?? n.args?.description)
  const details = description || command || '…'

  const wantsBackground = !!args.run_in_background
  const backgroundTaskId =
    isDone && !isError ? parseBackgroundTaskId(part) : null
  const isBackgrounded =
    !!backgroundTaskId || (wantsBackground && isDone && !isError)

  const action = shellAction({ isDone, isError, isBackgrounded })
  const hasOutput = typeof result === 'string' && result.length > 0
  const hasLiveOutput = part.liveOutput != null
  const isRunning = !isDone

  // Backgrounded: never auto-expand raw tool text (paths / agent copy).
  const [expanded, toggleExpanded] = useStreamingExpanded(
    isRunning && hasLiveOutput && !wantsBackground,
    {
      expandOnceWhen:
        isDone && !isBackgrounded && (isError || hasOutput),
    },
  )

  const showLive = expanded && hasLiveOutput && !isDone && !wantsBackground
  const showFinal = expanded && isDone && !isBackgrounded
  const titleTooltip =
    description && command && description !== command
      ? `${description}\n${command}`
      : details

  const onStop = e => {
    e.stopPropagation()
    if (isDone || part.stopping || !part.toolCallId) return
    void stopTool(part.toolCallId)
  }

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
          !isDone && part.liveElapsed != null
            ? `${part.liveElapsed}s`
            : null
        }
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
              <CopyButton text={result} label='Copy output' inline />
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

      {showFinal && hasOutput && (
        <pre
          className={`tool-row-body ui-shell-tool-call__output ${isError ? 'tool-row-body--error' : ''}`}
        >
          {result}
        </pre>
      )}
      {showFinal && !hasOutput && (
        <div className='tool-row-empty'>(no output)</div>
      )}
    </div>
  )
}
