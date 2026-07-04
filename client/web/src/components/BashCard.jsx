import React, { useState } from 'react'
import CopyButton from './CopyButton.jsx'
import ToolRowHeader from './ToolRowHeader.jsx'
import { detectError } from '../lib/utils.js'

/**
 * Compact one-line card for bash. Four modes:
 *   - { command, background: true } → "Started <command>"
 *   - { command }                   → "Ran <command>"
 *   - { kill: true, pid }           → "Killed pid N"
 *   - { pid }                       → "Checked pid N"
 *
 * Priority MUST mirror shell-runner's execute(): command wins over pid.
 * Some providers (OpenAI Responses API in strict-tools mode) stuff
 * default `pid: 0` into the args even when the model wants to run a real
 * command — without command-first priority the UI mis-labels every such
 * call as "Checked pid 0".
 *
 * Title uses `tool-row-title--plain` because a shell command is plain
 * mono text, not a clickable identifier — the default accent color for
 * filenames/queries reads wrong on `git status`.
 */

function describeBash(args) {
  if (!args || typeof args !== 'object') return { verb: 'Ran', text: '' }

  const cmd = typeof args.command === 'string' ? args.command.trim() : ''
  if (cmd) {
    return { verb: args.background ? 'Started' : 'Ran', text: cmd }
  }

  // Only honor pid when it's a real OS pid (>0). Strict-tools `pid: 0` is
  // a no-op default that gets confused for an intentional pid check.
  const pid = typeof args.pid === 'number' && args.pid > 0 ? args.pid : null
  if (pid != null) {
    return { verb: args.kill ? 'Killed' : 'Checked', text: `pid ${pid}` }
  }

  return { verb: 'Ran', text: '' }
}

export default function BashCard({ part }) {
  const [expanded, setExpanded] = useState(false)
  const args = part.args || {}
  const result = part.result
  const isDone = part.status === 'done'
  const isError = isDone && detectError(part.name || 'Bash', result)
  const { verb, text } = describeBash(args)
  const hasOutput = typeof result === 'string' && result.length > 0

  return (
    <div className={`tool-row bash-card ${isError ? 'has-error' : ''}`}>
      <ToolRowHeader
        expanded={expanded}
        onToggle={() => setExpanded(v => !v)}
        label={verb}
        title={text}
        titlePlain
        titleTooltip={text}
        duration={part.duration}
        isDone={isDone}
        isError={isError}
        actions={
          isDone && !isError && hasOutput ? (
            <CopyButton text={result} label='Copy output' inline />
          ) : null
        }
      />

      {expanded && isDone && hasOutput && (
        <pre
          className={`tool-row-body ${isError ? 'tool-row-body--error' : ''}`}
        >
          {result}
        </pre>
      )}
      {expanded && isDone && !hasOutput && (
        <div className='tool-row-empty'>(no output)</div>
      )}
    </div>
  )
}
