import React, { useState } from 'react'
import { formatWorkedDuration } from '../lib/timeline.js'

/**
 * Cursor default-chat `workGroup` disclosure (completed turn only).
 *
 * Label ≈ action "Worked" + details `g0m(durationMs)` → "for 7s".
 * With running tasks: "N working" (Cursor `runningTaskCount`).
 *
 * Controlled open via `open` + `onOpenChange` (parent keys by stable rowId).
 */
export default function WorkGroup({
  children,
  durationMs,
  runningTaskCount = 0,
  defaultOpen = false,
  open: openControlled,
  onOpenChange,
}) {
  const [openUncontrolled, setOpenUncontrolled] = useState(defaultOpen)
  const controlled = typeof openControlled === 'boolean'
  const open = controlled ? openControlled : openUncontrolled

  const setOpen = next => {
    const value = typeof next === 'function' ? next(open) : next
    if (!controlled) setOpenUncontrolled(value)
    onOpenChange?.(value)
  }

  const dur = formatWorkedDuration(durationMs)
  const isRunning = runningTaskCount > 0

  return (
    <div
      className={`work-group ${open ? 'open' : ''} ${isRunning ? 'active' : ''}`}
    >
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
        <span className='work-group-label'>
          {isRunning ? (
            <span className='work-group-action'>
              {runningTaskCount} working
            </span>
          ) : (
            <>
              <span className='work-group-action'>Worked</span>
              {dur ? (
                <span className='work-group-details'>{dur}</span>
              ) : null}
            </>
          )}
        </span>
        {isRunning && (
          <span className='spinner spinner-sm' aria-hidden='true' />
        )}
      </button>

      <div
        className='work-group-body'
        hidden={!open}
        aria-hidden={!open}
      >
        {children}
      </div>
    </div>
  )
}
