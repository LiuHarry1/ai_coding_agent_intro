import React, { useState } from 'react'
import { formatWorkedDuration } from '../lib/timeline.js'

/**
 * Cursor default-chat `workGroup` disclosure (completed turn only).
 *
 * Label ≈ action "Worked" + details `g0m(durationMs)` → "Worked for 7s".
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
  let label
  if (runningTaskCount > 0) {
    label = `${runningTaskCount} working`
  } else if (dur) {
    label = `Worked ${dur}`
  } else {
    label = 'Worked'
  }

  return (
    <div
      className={`work-group ${open ? 'open' : ''} ${runningTaskCount > 0 ? 'active' : ''}`}
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
        <span className='work-group-label'>{label}</span>
        {runningTaskCount > 0 && (
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
