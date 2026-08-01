import React, { useState } from 'react'
import { buildAssistantTimeline } from '../lib/timeline.js'
import CompactionRow from './CompactionRow.jsx'
import PartRenderer from './PartRenderer.jsx'
import WorkGroup from './WorkGroup.jsx'

export default function MessageBubble({ message, isLast = false }) {
  const [lightbox, setLightbox] = useState(null)

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
  const { rows, fold } = buildAssistantTimeline(parts, {
    streaming: messageStreaming,
  })

  const nodes = rows.map((part, i) => (
    <PartRenderer
      key={i}
      part={part}
      index={i}
      rowCount={rows.length}
      messageStreaming={messageStreaming}
    />
  ))
  const foldedNodes = fold ? nodes.slice(0, fold.split) : null
  const showFold = !!fold && foldedNodes.some(n => n != null)

  return (
    <div className='msg msg-assistant'>
      {showFold ? (
        <>
          <WorkGroup
            durationMs={fold.durationMs}
            runningTaskCount={fold.runningTaskCount}
            defaultOpen={isLast && !messageStreaming}
          >
            {foldedNodes}
          </WorkGroup>
          {nodes.slice(fold.split)}
        </>
      ) : (
        nodes
      )}
    </div>
  )
}
