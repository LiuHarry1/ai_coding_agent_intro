import React from 'react'

/** Dense early-turn placeholder — same visual tier as a tool-row. */
export default function ThinkingDots() {
  return (
    <div className='thinking-indicator thinking-indicator--dense'>
      <span className='reasoning-pulse' />
      <span>Thinking...</span>
    </div>
  )
}
