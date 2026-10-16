import React, { useEffect, useRef, useState } from 'react'
import mermaid from 'mermaid'
import { useChatStore } from '../stores/chat-store.js'

let renderSerial = 0
let activeMermaidTheme = null

const SHARED_CONFIG = {
  startOnLoad: false,
  securityLevel: 'loose',
  fontFamily:
    'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
  flowchart: {
    useMaxWidth: true,
    htmlLabels: true,
    curve: 'basis',
    padding: 14,
    nodeSpacing: 36,
    rankSpacing: 48,
    wrappingWidth: 200,
  },
}

function mermaidThemeFor(appTheme) {
  return appTheme === 'light' ? 'default' : 'dark'
}

/** Re-init when app theme changes so SVG matches light/dark UI. */
function ensureInit(appTheme) {
  const theme = mermaidThemeFor(appTheme)
  if (activeMermaidTheme === theme) return
  activeMermaidTheme = theme
  mermaid.initialize({
    ...SHARED_CONFIG,
    theme,
    themeVariables: {
      fontSize: '13px',
      fontFamily:
        'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
      ...(theme === 'default'
        ? {
            background: 'transparent',
            primaryColor: '#ffffff',
            primaryBorderColor: '#d1d9e0',
            primaryTextColor: '#1f2328',
            secondaryColor: '#f6f8fa',
            tertiaryColor: '#fafbfc',
            lineColor: '#0969da',
            textColor: '#1f2328',
            mainBkg: '#ffffff',
            nodeBorder: '#d1d9e0',
            clusterBkg: '#f6f8fa',
            clusterBorder: '#d1d9e0',
            titleColor: '#1f2328',
            edgeLabelBackground: '#ffffff',
          }
        : {}),
    },
  })
}
function normalizeMermaidSource(source) {
  // Convert hard line breaks inside node labels to <br/> so multi-line text renders.
  let out = source.replace(/\[([^\]]*)\]/g, (match, inner) => {
    if (inner.includes('<br') || inner.includes('|')) return match
    return `[${inner.replace(/\n/g, '<br/>')}]`
  })
  // Quote edge labels (`-->|label|`). LLMs frequently emit labels containing
  // characters like ()/:+ which mermaid only accepts inside quotes; without this
  // the whole diagram fails to parse.
  out = out.replace(/\|([^|\n]+)\|/g, (match, label) => {
    const trimmed = label.trim()
    if (!trimmed || (trimmed.startsWith('"') && trimmed.endsWith('"')))
      return match
    return `|"${trimmed.replace(/"/g, '&quot;')}"|`
  })
  return out
}

function downloadSvg(svg, filename = 'diagram.svg') {
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    /* clipboard may be unavailable */
  }
}

function IconExpand() {
  return (
    <svg
      width='14'
      height='14'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='2'
      aria-hidden='true'
    >
      <path
        d='M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7'
        strokeLinecap='round'
        strokeLinejoin='round'
      />
    </svg>
  )
}

function IconCopy() {
  return (
    <svg
      width='14'
      height='14'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='2'
      aria-hidden='true'
    >
      <rect x='9' y='9' width='13' height='13' rx='2' />
      <path
        d='M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1'
        strokeLinecap='round'
        strokeLinejoin='round'
      />
    </svg>
  )
}

const RENDER_DEBOUNCE_MS = 200
const RENDER_TIMEOUT_MS = 15000

function MermaidDiagram({ code, streaming = false }) {
  const appTheme = useChatStore(s => s.theme)
  const inlineHostRef = useRef(null)
  const modalHostRef = useRef(null)
  const bindRef = useRef(null)
  const panStartRef = useRef(null)

  const [svg, setSvg] = useState('')
  const [error, setError] = useState(null)
  const [expanded, setExpanded] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [panning, setPanning] = useState(false)

  const shouldRender = !streaming
  const rendering = shouldRender && !svg && !error

  useEffect(() => {
    if (!shouldRender) {
      setSvg('')
      setError(null)
      bindRef.current = null
      return undefined
    }

    ensureInit(appTheme)
    let cancelled = false
    setSvg('')
    setError(null)
    const timeout = setTimeout(() => {
      if (cancelled) return
      setError('Diagram render timed out')
      setSvg('')
    }, RENDER_TIMEOUT_MS)

    const handle = setTimeout(() => {
      const normalized = normalizeMermaidSource(code)
      const renderId = `mmd-${++renderSerial}`

      mermaid
        .render(renderId, normalized)
        .then(({ svg: nextSvg, bindFunctions }) => {
          if (cancelled) return
          clearTimeout(timeout)
          bindRef.current = bindFunctions ?? null
          setSvg(nextSvg)
          setError(null)
        })
        .catch(e => {
          if (cancelled) return
          clearTimeout(timeout)
          document
            .querySelectorAll(`[id^="d${renderId}"]`)
            .forEach(n => n.remove())
          bindRef.current = null
          setSvg('')
          setError(String(e?.message || e))
        })
    }, RENDER_DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(handle)
      clearTimeout(timeout)
    }
  }, [code, shouldRender, appTheme])
  useEffect(() => {
    if (!svg || !inlineHostRef.current) return
    try {
      bindRef.current?.(inlineHostRef.current)
    } catch {
      /* interactive bindings are optional for static flowcharts */
    }
  }, [svg])

  useEffect(() => {
    if (!expanded || !svg || !modalHostRef.current) return
    try {
      bindRef.current?.(modalHostRef.current)
    } catch {
      /* optional */
    }
  }, [expanded, svg])

  useEffect(() => {
    if (!expanded) {
      setZoom(1)
      setPan({ x: 0, y: 0 })
      setPanning(false)
      panStartRef.current = null
      return undefined
    }
    const onKey = e => {
      if (e.key === 'Escape') setExpanded(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded])

  function resetView() {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }

  function onPanPointerDown(e) {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    panStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      panX: pan.x,
      panY: pan.y,
    }
    setPanning(true)
  }

  function onPanPointerMove(e) {
    const start = panStartRef.current
    if (!start) return
    setPan({
      x: start.panX + (e.clientX - start.x),
      y: start.panY + (e.clientY - start.y),
    })
  }

  function onPanPointerUp(e) {
    panStartRef.current = null
    setPanning(false)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  if (!shouldRender) {
    return (
      <div className='mermaid-pending mermaid-block' aria-busy={streaming}>
        {streaming && (
          <div className='mermaid-pending-status'>
            <span className='spinner spinner-sm' aria-hidden='true' />
            <span>Generating diagram…</span>
          </div>
        )}
        <div className='mermaid-pending-code'>{code}</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className='mermaid-failed mermaid-block'>
        <div className='mermaid-failed-head'>Could not render diagram</div>
        {error && error !== 'true' ? (
          <div className='mermaid-failed-msg'>{error}</div>
        ) : null}
        <div className='mermaid-pending-code'>{code}</div>
      </div>
    )
  }

  return (
    <>
      <div className='mermaid-wrap mermaid-block'>
        {!rendering && svg && (
          <div className='mermaid-float-actions'>
            <button
              type='button'
              className='mermaid-icon-btn'
              onClick={() => setExpanded(true)}
              aria-label='Expand diagram'
              title='Expand'
            >
              <IconExpand />
            </button>
            <button
              type='button'
              className='mermaid-icon-btn'
              onClick={() => copyText(code)}
              aria-label='Copy source'
              title='Copy source'
            >
              <IconCopy />
            </button>
          </div>
        )}
        <div className='mermaid-diagram'>
          {rendering && (
            <div className='mermaid-rendering'>
              <span className='spinner spinner-sm' aria-hidden='true' />
              <span>Rendering diagram…</span>
            </div>
          )}
          {svg ? (
            <div
              ref={inlineHostRef}
              className='mermaid-diagram-canvas'
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          ) : null}
        </div>
      </div>

      {expanded && svg && (
        <div
          className='mermaid-modal'
          role='dialog'
          aria-modal='true'
          aria-label='Mermaid diagram'
          onClick={() => setExpanded(false)}
        >
          <div
            className='mermaid-modal-panel'
            onClick={e => e.stopPropagation()}
          >
            <div className='mermaid-modal-head'>
              <span>Mermaid diagram</span>
              <div className='mermaid-modal-controls'>
                <button
                  type='button'
                  className='mermaid-toolbar-btn'
                  onClick={() =>
                    setZoom(z => Math.max(0.5, +(z - 0.25).toFixed(2)))
                  }
                  aria-label='Zoom out'
                >
                  −
                </button>
                <span className='mermaid-zoom-label'>
                  {Math.round(zoom * 100)}%
                </span>
                <button
                  type='button'
                  className='mermaid-toolbar-btn'
                  onClick={() =>
                    setZoom(z => Math.min(3, +(z + 0.25).toFixed(2)))
                  }
                  aria-label='Zoom in'
                >
                  +
                </button>
                {(zoom !== 1 || pan.x !== 0 || pan.y !== 0) && (
                  <button
                    type='button'
                    className='mermaid-toolbar-btn'
                    onClick={resetView}
                  >
                    Reset
                  </button>
                )}
                <button
                  type='button'
                  className='mermaid-toolbar-btn'
                  onClick={() => downloadSvg(svg)}
                >
                  Download
                </button>
                <button
                  type='button'
                  className='mermaid-modal-close'
                  onClick={() => setExpanded(false)}
                  aria-label='Close'
                >
                  ×
                </button>
              </div>
            </div>
            <div
              className={`mermaid-modal-body${panning ? ' is-panning' : ''}`}
              onPointerDown={onPanPointerDown}
              onPointerMove={onPanPointerMove}
              onPointerUp={onPanPointerUp}
              onPointerCancel={onPanPointerUp}
            >
              <div
                className='mermaid-modal-viewport'
                style={{
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                  transformOrigin: 'top center',
                }}
              >
                <div
                  ref={modalHostRef}
                  className='mermaid-modal-diagram'
                  dangerouslySetInnerHTML={{ __html: svg }}
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

MermaidDiagram.mermaidBlock = true

export default React.memo(MermaidDiagram)
