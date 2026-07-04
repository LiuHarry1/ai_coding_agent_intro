import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useChatStore } from '../../stores/chat-store.js'
import { DownloadIcon, TrashIcon } from './icons.jsx'

/**
 * Right-click context menu for file-tree rows. Rendered in a portal so it
 * isn't clipped by the tree's overflow scroll container.
 *
 * `menu` shape: { x, y, target: { path, name, isDir } } | null
 */
export default function TreeContextMenu({
  menu,
  onClose,
  onDelete,
  onDownload,
}) {
  const theme = useChatStore(s => s.theme)
  const menuRef = useRef(null)
  const [pos, setPos] = useState({ x: 0, y: 0 })

  useLayoutEffect(() => {
    if (!menu) return
    const el = menuRef.current
    if (!el) {
      setPos({ x: menu.x, y: menu.y })
      return
    }
    const pad = 8
    const rect = el.getBoundingClientRect()
    let x = menu.x
    let y = menu.y
    if (x + rect.width > window.innerWidth - pad)
      x = window.innerWidth - rect.width - pad
    if (y + rect.height > window.innerHeight - pad)
      y = window.innerHeight - rect.height - pad
    setPos({ x: Math.max(pad, x), y: Math.max(pad, y) })
  }, [menu])

  useEffect(() => {
    if (!menu) return
    const close = () => onClose()
    const onKey = e => {
      if (e.key === 'Escape') close()
    }
    // Defer so the opening right-click doesn't immediately close the menu.
    const t = setTimeout(() => {
      window.addEventListener('click', close)
      window.addEventListener('contextmenu', close)
      window.addEventListener('scroll', close, true)
    }, 0)
    window.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(t)
      window.removeEventListener('click', close)
      window.removeEventListener('contextmenu', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu, onClose])

  if (!menu) return null

  const { target } = menu

  return createPortal(
    <div
      ref={menuRef}
      className='tree-ctx-menu'
      data-theme={theme}
      style={{ top: pos.y, left: pos.x }}
      role='menu'
      onClick={e => e.stopPropagation()}
      onContextMenu={e => e.preventDefault()}
    >
      <button
        type='button'
        className='tree-ctx-item'
        role='menuitem'
        onClick={() => {
          onDownload(target)
          onClose()
        }}
      >
        <DownloadIcon size={13} />
        Download{target.isDir ? ' as ZIP' : ''}
      </button>
      <button
        type='button'
        className='tree-ctx-item'
        role='menuitem'
        onClick={() => {
          onDelete(target)
          onClose()
        }}
      >
        <TrashIcon size={13} />
        Delete{target.isDir ? ' folder' : ''}…
      </button>
    </div>,
    document.body,
  )
}
