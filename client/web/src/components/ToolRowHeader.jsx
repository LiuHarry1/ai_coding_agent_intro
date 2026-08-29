import React from 'react'
import { formatDuration } from '../lib/utils.js'

/**
 * Shared single-row tool header (implementation of ToolCallLine).
 *
 * Prefer importing `ToolCallLine` in new code — same component, Cursor-aligned name
 * (≈ `ui-tool-call-line`).
 *
 * Slot layout (left → right):
 *
 *   [chevron?] [icon?] [label] [title] [subtitle] · · · [meta] [duration] [actions] [status]
 *
 * Slots beyond `title` are all optional. `actions` is rendered inside a
 * stopPropagation wrapper so a copy button there won't toggle the row.
 */
export default function ToolRowHeader({
  expanded,
  onToggle,
  showChevron = true,
  /** Reserve chevron column width even when no arrow (align sibling rows). */
  chevronSlot = false,
  icon,
  label,
  title,
  titleTooltip,
  titlePlain,
  subtitle,
  subtitleTooltip,
  meta,
  duration,
  isDone,
  isError,
  actions,
  emptyHint,
  showSuccess,
}) {
  const stop = e => e.stopPropagation()
  const dur = typeof duration === 'string' ? duration : formatDuration(duration)
  const showSlot = showChevron || chevronSlot

  return (
    <button
      type='button'
      className='tool-row-header'
      onClick={onToggle}
      aria-expanded={expanded}
      aria-disabled={!onToggle || undefined}
    >
      {showSlot && (
        <span
          className={`tool-row-chevron ${expanded && showChevron ? 'open' : ''} ${showChevron ? '' : 'tool-row-chevron--slot'}`}
          aria-hidden='true'
        >
          {showChevron ? '\u25B6' : ''}
        </span>
      )}
      {icon != null && (
        <span className='tool-row-icon' aria-hidden='true'>
          {icon}
        </span>
      )}
      {label && <span className='tool-row-label'>{label}</span>}
      {title != null && (
        <span
          className={`tool-row-title ${titlePlain ? 'tool-row-title--plain' : ''}`}
          title={
            titleTooltip ?? (typeof title === 'string' ? title : undefined)
          }
        >
          {title}
        </span>
      )}
      {subtitle && (
        <span
          className='tool-row-subtitle'
          title={
            subtitleTooltip ??
            (typeof subtitle === 'string' ? subtitle : undefined)
          }
        >
          {subtitle}
        </span>
      )}
      <span className='tool-row-spacer' />
      {meta}
      {dur && isDone && <span className='tool-row-duration'>{dur}</span>}
      {actions && (
        <span className='tool-row-actions' onClick={stop}>
          {actions}
        </span>
      )}
      {!isDone && <span className='spinner spinner-sm' />}
      {isDone && isError && (
        <span
          className='tool-row-status tool-row-status--error'
          aria-label='failed'
        >
          {'\u2717'}
        </span>
      )}
      {isDone && !isError && emptyHint && (
        <span
          className='tool-row-status tool-row-status--empty'
          title={emptyHint}
        >
          {'\u2205'}
        </span>
      )}
      {isDone && !isError && !emptyHint && showSuccess && (
        <span className='tool-row-status tool-row-status--ok' aria-label='done'>
          {'\u2713'}
        </span>
      )}
    </button>
  )
}
