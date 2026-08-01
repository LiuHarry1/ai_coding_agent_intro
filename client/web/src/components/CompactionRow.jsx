import React, { useState } from 'react'
import ToolCallLine from './ToolCallLine.jsx'
import CopyButton from './CopyButton.jsx'

/**
 * Single timeline row for full compaction. Rides on ToolCallLine so it
 * shares the exact visual language of the tool rows around it.
 * state: 'running' | 'done' | 'error'.
 */
export default function CompactionRow({ state, summary }) {
  const [expanded, setExpanded] = useState(false)
  const expandable = state === 'done' && !!summary

  if (state === 'running') {
    return (
      <div className='tool-row compaction-row'>
        <ToolCallLine
          showChevron={false}
          label={'Summarizing chat context\u2026'}
          isDone={false}
        />
      </div>
    )
  }

  if (state === 'error') {
    return (
      <div className='tool-row compaction-row has-error'>
        <ToolCallLine
          showChevron={false}
          label='Chat context summarization failed'
          isDone
          isError
        />
      </div>
    )
  }

  return (
    <div className='tool-row compaction-row'>
      <ToolCallLine
        expanded={expanded}
        onToggle={expandable ? () => setExpanded(v => !v) : undefined}
        showChevron={expandable}
        label='Chat context summarized'
        isDone
        actions={
          summary ? <CopyButton text={summary} label='Copy' inline /> : null
        }
      />
      {expanded && expandable && (
        <pre className='compaction-summary'>{summary}</pre>
      )}
    </div>
  )
}
