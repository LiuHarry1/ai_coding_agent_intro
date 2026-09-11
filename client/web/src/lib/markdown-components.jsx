import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import Mermaid from '../components/Mermaid.jsx'
import { fetchAuthenticatedResourceBlobUrl } from './api/workspace.js'

function isMermaidBlock(child) {
  if (!React.isValidElement(child)) return false
  const t = child.type
  if (t === Mermaid) return true
  if (typeof t === 'object' && t !== null && t.type?.mermaidBlock) return true
  const cn = child.props?.className
  return typeof cn === 'string' && cn.includes('mermaid-block')
}

/** Drop the markdown <pre> wrapper for mermaid — it adds a second border. */
function pre({ children, ...props }) {
  const items = React.Children.toArray(children)
  if (items.length === 1 && isMermaidBlock(items[0])) {
    return items[0]
  }
  return <pre {...props}>{children}</pre>
}

function makeCode(streaming) {
  return function code({ inline, className, children, ...props }) {
    const lang = /language-(\w+)/.exec(className || '')?.[1]
    if (!inline && lang === 'mermaid') {
      const source = String(children ?? '').replace(/\n$/, '')
      return <Mermaid code={source} streaming={streaming} />
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    )
  }
}

function workspacePreviewResource(href) {
  if (typeof href !== 'string') return null
  try {
    const parsed = new URL(
      href,
      globalThis.location?.origin || 'http://localhost',
    )
    const marker = '/workspace/preview'
    const index = parsed.pathname.indexOf(marker)
    if (index < 0) return null
    return `${parsed.pathname.slice(index)}${parsed.search}`
  } catch {
    return null
  }
}

function PreviewLink({ href, children, ...props }) {
  const resource = workspacePreviewResource(href)
  const [open, setOpen] = useState(false)
  const [src, setSrc] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!open || !resource) return undefined
    let revoked = false
    let objectUrl = null
    setError(null)
    fetchAuthenticatedResourceBlobUrl(resource)
      .then(url => {
        if (revoked) {
          URL.revokeObjectURL(url)
          return
        }
        objectUrl = url
        setSrc(url)
      })
      .catch(err => {
        if (!revoked) setError(err.message || 'Preview failed')
      })
    return () => {
      revoked = true
      setSrc(null)
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [open, resource])

  useEffect(() => {
    if (!open) return undefined
    const close = event => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [open])

  if (!resource) {
    return (
      <a href={href} {...props}>
        {children}
      </a>
    )
  }

  const modal =
    open &&
    createPortal(
      <div
        className='chart-preview-backdrop'
        role='presentation'
        onMouseDown={event => {
          if (event.target === event.currentTarget) setOpen(false)
        }}
      >
        <section
          className='chart-preview-dialog'
          role='dialog'
          aria-modal='true'
          aria-label='Interactive chart preview'
        >
          <div className='chart-preview-toolbar'>
            <span>Interactive chart preview</span>
            <button type='button' onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
          {!src && !error && (
            <div className='chart-preview-status'>Loading preview…</div>
          )}
          {error && (
            <div className='chart-preview-status chart-preview-status--error'>
              {error}
            </div>
          )}
          {src && (
            <iframe
              className='chart-preview-frame'
              src={src}
              title='Interactive chart preview'
              sandbox='allow-scripts allow-downloads'
            />
          )}
        </section>
      </div>,
      document.body,
    )

  return (
    <>
      <a
        href={href}
        {...props}
        onClick={event => {
          event.preventDefault()
          setOpen(true)
        }}
      >
        {children}
      </a>
      {modal}
    </>
  )
}

const MD_COMPONENTS_IDLE = {
  pre,
  code: makeCode(false),
  a: PreviewLink,
}

const MD_COMPONENTS_STREAMING = {
  pre,
  code: makeCode(true),
  a: PreviewLink,
}

export function getMdComponents({ streaming = false } = {}) {
  return streaming ? MD_COMPONENTS_STREAMING : MD_COMPONENTS_IDLE
}

export const mdComponents = MD_COMPONENTS_IDLE

export function createMdComponents({ streaming = false } = {}) {
  return getMdComponents({ streaming })
}
