import React, { useEffect, useRef } from 'react'

/**
 * Vertical drag bar for resizing panels.
 *
 * - mode "absolute" (default): onResize(clientX) — used for the IDE's right
 *   edge (width = distance from viewport left).
 * - mode "delta": onResize(startSize + deltaX) — used between tree/editor.
 *
 * While dragging, window-level mousemove/mouseup keep the drag smooth when
 * the cursor leaves the handle; a page-wide class locks col-resize + blocks
 * text selection. Movement is RAF-throttled.
 */
export default function ResizeHandle({
  onResize,
  onReset,
  mode = 'absolute',
  getSize,
  className = 'workspace-ide-resize',
}) {
  const dragging = useRef(false)
  const rafId = useRef(0)
  const latestX = useRef(0)
  const startX = useRef(0)
  const startSize = useRef(0)

  useEffect(() => () => cancelAnimationFrame(rafId.current), [])

  const handleMouseDown = e => {
    e.preventDefault()
    dragging.current = true
    document.body.classList.add('is-resizing-ide')
    startX.current = e.clientX
    startSize.current = getSize?.() ?? 0

    const onMove = ev => {
      latestX.current = ev.clientX
      if (rafId.current) return
      rafId.current = requestAnimationFrame(() => {
        rafId.current = 0
        if (!dragging.current) return
        if (mode === 'delta') {
          onResize(startSize.current + (latestX.current - startX.current))
        } else {
          onResize(latestX.current)
        }
      })
    }
    const onUp = () => {
      dragging.current = false
      document.body.classList.remove('is-resizing-ide')
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div
      className={className}
      onMouseDown={handleMouseDown}
      onDoubleClick={onReset}
      title='Drag to resize · double-click to reset'
      role='separator'
      aria-orientation='vertical'
    />
  )
}
