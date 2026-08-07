import React, { useCallback, useState } from 'react'
import {
  buildAssistantTimeline,
  timelineRowKey,
} from '../lib/timeline.js'
import CompactionRow from './CompactionRow.jsx'
import PartRenderer from './PartRenderer.jsx'
import WorkGroup from './WorkGroup.jsx'

/**
 * Assistant / user bubble.
 *
 * Work folds only appear on completed turns (Cursor default `U0m`).
 * Expand state is keyed by stable work_group `rowId`
 * (≈ `expansionOverrides` / `workGroupControl`).
 */
export default function MessageBubble({ message }) {
  const [lightbox, setLightbox] = useState(null)
  const [expansionOverrides, setExpansionOverrides] = useState(
    () => new Map(),
  )

  const isWorkOpen = useCallback(
    rowId => expansionOverrides.get(rowId) ?? false,
    [expansionOverrides],
  )

  const setWorkOpen = useCallback((rowId, open) => {
    setExpansionOverrides(prev => {
      if (prev.get(rowId) === open) return prev
      const next = new Map(prev)
      next.set(rowId, open)
      return next
    })
  }, [])

  if (message.type === 'compact_boundary') {
    return (
      <div className='msg msg-compact-boundary'>
        <CompactionRow state='done' summary={message.summary} />
      </div>
    )
  }

  if (message.type === 'user') {
    return (
      <div className='msg msg-user'>
        {message.images && message.images.length > 0 && (
          <div className='msg-user-images'>
            {message.images.map((src, i) => (
              <img
                key={i}
                src={src}
                alt={`Attachment ${i + 1}`}
                className='msg-user-img'
                onClick={() => setLightbox(src)}
              />
            ))}
          </div>
        )}
        {message.content}
        {lightbox && (
          <div className='lightbox' onClick={() => setLightbox(null)}>
            <img src={lightbox} alt='Preview' />
          </div>
        )}
      </div>
    )
  }

  if (message.type !== 'assistant') return null

  const { parts = [] } = message
  const messageStreaming = message.status === 'streaming'
  const { rows } = buildAssistantTimeline(parts, {
    streaming: messageStreaming,
    messageId: message.id,
  })

  const renderPart = (part, i, rowCount) => (
    <PartRenderer
      key={timelineRowKey(part, i)}
      part={part}
      index={i}
      rowCount={rowCount}
      messageStreaming={messageStreaming}
    />
  )

  return (
    <div className='msg msg-assistant'>
      {rows.map((row, i) => {
        if (row.type === 'work_group') {
          const kids = row.children || []
          return (
            <WorkGroup
              key={row.rowId}
              durationMs={row.durationMs}
              runningTaskCount={row.runningTaskCount}
              open={isWorkOpen(row.rowId)}
              onOpenChange={open => setWorkOpen(row.rowId, open)}
            >
              {kids.map((child, j) => renderPart(child, j, kids.length))}
            </WorkGroup>
          )
        }
        return renderPart(row, i, rows.length)
      })}
    </div>
  )
}
