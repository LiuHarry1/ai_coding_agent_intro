import React from 'react'
import CopyButton from './CopyButton.jsx'
import ToolCallLine from './ToolCallLine.jsx'
import LiveTerminal from './LiveTerminal.jsx'
import { detectError } from '../lib/utils.js'
import { liveToolSubtitle } from '../lib/tool-density.js'
import { useStreamingExpanded } from '../lib/use-streaming-expanded.js'

/**
 * Compact one-line card for bash (Cursor shellToolCall ≈ action "Shell").
 * Streams liveOutput into LiveTerminal while running (same data ToolCallCard used).
 */

function describeBash(args) {
  if (!args || typeof args !== 'object') return { verb: 'Shell', text: '' }

  const cmd = typeof args.command === 'string' ? args.command.trim() : ''
  if (cmd) {
    return { verb: 'Shell', text: cmd }
  }

  const pid = typeof args.pid === 'number' && args.pid > 0 ? args.pid : null
  if (pid != null) {
    return { verb: args.kill ? 'Killed' : 'Checked', text: `pid ${pid}` }
  }

  return { verb: 'Shell', text: '' }
}

export default function BashCard({ part }) {
  const args = part.args || {}
  const result =
    part.toolUseResult?.text != null ? part.toolUseResult.text : part.result
  const isDone = part.status === 'done'
  const isError =
    isDone &&
    (part.isError === true ||
      part.toolUseResult?.interrupted === true ||
      detectError(part.name || 'Bash', result))
  const { verb, text } = describeBash(args)
  const hasOutput = typeof result === 'string' && result.length > 0
  const hasLiveOutput = part.liveOutput != null
  const isRunning = !isDone

  const [expanded, toggleExpanded] = useStreamingExpanded(
    isRunning && hasLiveOutput,
    { expandOnceWhen: isDone && (isError || hasOutput) },
  )

  const liveSub = !isDone ? liveToolSubtitle(part) : null
  const showLive = expanded && hasLiveOutput && !isDone
  const showFinal = expanded && isDone

  return (
    <div className={`tool-row bash-card ${isError ? 'has-error' : ''}`}>
      <ToolCallLine
        expanded={expanded}
        onToggle={toggleExpanded}
        label={verb}
        title={text}
        titlePlain
        titleTooltip={text}
        subtitle={
          liveSub && liveSub !== text
            ? liveSub
            : !isDone && part.liveElapsed != null
              ? `${part.liveElapsed}s`
              : null
        }
        duration={part.duration}
        isDone={isDone}
        isError={isError}
        actions={
          isDone && !isError && hasOutput ? (
            <CopyButton text={result} label='Copy output' inline />
          ) : null
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
          className={`tool-row-body ${isError ? 'tool-row-body--error' : ''}`}
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
