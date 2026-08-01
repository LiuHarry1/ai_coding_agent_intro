import React, { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { getMdComponents } from '../lib/markdown-components.jsx'

export default function ReasoningBlock({ part }) {
  const [open, setOpen] = useState(false)
  const isStreaming = part.status === 'streaming'
  const mdComponents = getMdComponents({ streaming: isStreaming })

  const label = isStreaming
    ? 'Thinking...'
    : `Thought for ${part.duration ?? 0}s`

  return (
    <div className={`reasoning-block ${isStreaming ? 'streaming' : 'done'}`}>
      <button className='reasoning-toggle' onClick={() => setOpen(v => !v)}>
        <svg
          className={`reasoning-arrow ${open ? 'open' : ''}`}
          width='12'
          height='12'
          viewBox='0 0 24 24'
          fill='none'
          stroke='currentColor'
          strokeWidth='2.5'
          strokeLinecap='round'
          strokeLinejoin='round'
        >
          <polyline points='9 6 15 12 9 18' />
        </svg>
        <span className='reasoning-label'>
          {isStreaming && <span className='reasoning-pulse' />}
          {label}
        </span>
      </button>
      {(open || isStreaming) && part.content && (
        <div className='reasoning-content'>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={mdComponents}
          >
            {part.content}
          </ReactMarkdown>
        </div>
      )}
    </div>
  )
}
