import React, { useEffect, useRef } from 'react'

/** Streaming shell output panel (bash wait / progress). */
export default function LiveTerminal({ output, elapsed, done }) {
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
