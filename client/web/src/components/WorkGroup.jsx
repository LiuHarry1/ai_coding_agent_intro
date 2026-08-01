import React, { useState } from 'react'
import { formatDuration } from '../lib/utils.js'

/**
 * Turn-level work fold, mirroring Cursor's `workGroup` transcript row.
 *
 * Once a turn completes, every work row before the final assistant message
 * (reasoning, tool rows, subagent rows, compaction, todos) collapses under a
 * single header. The final answer itself stays outside the fold.
 *
 * Header reads `N working` while tasks are still active, else `Worked for Ns`.
 */
export default function WorkGroup({
  children,
  durationMs,
  runningTaskCount = 0,
  defaultOpen = false,
}) {
  const [open, setOpen] = useState(defaultOpen)

  const dur = formatDuration(durationMs)
  const label =
    runningTaskCount > 0
      ? `${runningTaskCount} working`
      : dur
        ? `Worked for ${dur}`
        : 'Worked'

  return (
    <div className={`work-group ${open ? 'open' : ''}`}>
      <button
        type='button'
        className='work-group-header'
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
      >
        <span
          className={`work-group-chevron ${open ? 'open' : ''}`}
          aria-hidden='true'
        >
          {'\u25B6'}
        </span>
        <span className='work-group-label'>{label}</span>
        {runningTaskCount > 0 && (
          <span className='spinner spinner-sm' aria-hidden='true' />
        )}
      </button>

      {open && <div className='work-group-body'>{children}</div>}
    </div>
  )
}
