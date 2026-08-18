import React, { useEffect, useMemo, useState } from 'react'
import ToolCallLine from './ToolCallLine.jsx'
import CopyButton from './CopyButton.jsx'
import { apiUrl, withAuth } from '../lib/api/_http.js'
import { useStreamingExpanded } from '../lib/use-streaming-expanded.js'
import {
  BROWSER_CLICK,
  BROWSER_CONSOLE,
  BROWSER_EVALUATE,
  BROWSER_FILE_UPLOAD,
  BROWSER_FILL_FORM,
  BROWSER_HANDLE_DIALOG,
  BROWSER_HOVER,
  BROWSER_NAVIGATE,
  BROWSER_NETWORK,
  BROWSER_PRESS_KEY,
  BROWSER_SCREENSHOT,
  BROWSER_SCROLL,
  BROWSER_SELECT_OPTION,
  BROWSER_SNAPSHOT,
  BROWSER_TABS,
  BROWSER_TYPE,
  BROWSER_WAIT_FOR,
  BROWSER_LOCK,
  BROWSER_FIND,
  BROWSER_DRAG,
  BROWSER_MOUSE_CLICK_XY,
} from '../lib/tool-names.js'

/**
 * One card for the whole `browser_*` family.
 *
 * The tool result deliberately never carries image bytes (the server strips
 * base64 via outputSchema), so the screenshot is fetched from its session URL —
 * through `fetch` rather than a bare `<img src>` so the bearer token still
 * applies when auth is on.
 */

const ICONS = {
  [BROWSER_NAVIGATE]: '\u{1F310}',
  [BROWSER_SNAPSHOT]: '\u{1F50D}',
  [BROWSER_CLICK]: '\u{1F5B1}',
  [BROWSER_HOVER]: '\u{1F5B1}',
  [BROWSER_TYPE]: '\u{2328}',
  [BROWSER_FILL_FORM]: '\u{1F4DD}',
  [BROWSER_FILE_UPLOAD]: '\u{1F4C2}',
  [BROWSER_HANDLE_DIALOG]: '\u{1F4AC}',
  [BROWSER_PRESS_KEY]: '\u{2328}',
  [BROWSER_WAIT_FOR]: '\u{23F3}',
  [BROWSER_SELECT_OPTION]: '\u{2328}',
  [BROWSER_SCROLL]: '\u{2195}',
  [BROWSER_SCREENSHOT]: '\u{1F4F8}',
  [BROWSER_CONSOLE]: '\u{1F41E}',
  [BROWSER_NETWORK]: '\u{1F4E1}',
  [BROWSER_TABS]: '\u{1F5C2}',
  [BROWSER_EVALUATE]: '\u{0192}',
  [BROWSER_LOCK]: '\u{1F512}',
  [BROWSER_FIND]: '\u{1F50E}',
  [BROWSER_DRAG]: '\u{2194}',
  [BROWSER_MOUSE_CLICK_XY]: '\u{1F5B1}',
}

const RUNNING_LABELS = {
  [BROWSER_NAVIGATE]: 'Opening page',
  [BROWSER_SNAPSHOT]: 'Reading page',
  [BROWSER_CLICK]: 'Clicking',
  [BROWSER_HOVER]: 'Hovering',
  [BROWSER_TYPE]: 'Typing',
  [BROWSER_FILL_FORM]: 'Filling form',
  [BROWSER_FILE_UPLOAD]: 'Uploading file',
  [BROWSER_HANDLE_DIALOG]: 'Handling dialog',
  [BROWSER_PRESS_KEY]: 'Pressing key',
  [BROWSER_WAIT_FOR]: 'Waiting',
  [BROWSER_SELECT_OPTION]: 'Selecting',
  [BROWSER_SCROLL]: 'Scrolling',
  [BROWSER_SCREENSHOT]: 'Taking screenshot',
  [BROWSER_CONSOLE]: 'Reading console',
  [BROWSER_NETWORK]: 'Reading network',
  [BROWSER_TABS]: 'Managing tabs',
  [BROWSER_EVALUATE]: 'Evaluating',
  [BROWSER_LOCK]: 'Locking browser',
  [BROWSER_FIND]: 'Searching page',
  [BROWSER_DRAG]: 'Dragging',
  [BROWSER_MOUSE_CLICK_XY]: 'Clicking at point',
}

const DONE_LABELS = {
  [BROWSER_NAVIGATE]: 'Opened page',
  [BROWSER_SNAPSHOT]: 'Read page',
  [BROWSER_CLICK]: 'Clicked',
  [BROWSER_HOVER]: 'Hovered',
  [BROWSER_TYPE]: 'Typed',
  [BROWSER_FILL_FORM]: 'Filled form',
  [BROWSER_FILE_UPLOAD]: 'Uploaded file',
  [BROWSER_HANDLE_DIALOG]: 'Handled dialog',
  [BROWSER_PRESS_KEY]: 'Pressed key',
  [BROWSER_WAIT_FOR]: 'Waited',
  [BROWSER_SELECT_OPTION]: 'Selected',
  [BROWSER_SCROLL]: 'Scrolled',
  [BROWSER_SCREENSHOT]: 'Screenshot',
  [BROWSER_CONSOLE]: 'Console',
  [BROWSER_NETWORK]: 'Network',
  [BROWSER_TABS]: 'Tabs',
  [BROWSER_EVALUATE]: 'Evaluated',
  [BROWSER_LOCK]: 'Browser lock',
  [BROWSER_FIND]: 'Found on page',
  [BROWSER_DRAG]: 'Dragged',
  [BROWSER_MOUSE_CLICK_XY]: 'Clicked at point',
}

function compactUrl(url) {
  if (typeof url !== 'string' || !url) return ''
  try {
    const u = new URL(url)
    const tail = (u.pathname + u.search).replace(/\/$/, '')
    const full = `${u.host}${tail}`
    return full.length > 64 ? `${full.slice(0, 61)}\u2026` : full
  } catch {
    return url.length > 64 ? `${url.slice(0, 61)}\u2026` : url
  }
}

/** Load an authed image into an object URL, revoking it on unmount. */
function useAuthedImage(path) {
  const [src, setSrc] = useState(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!path) {
      setSrc(null)
      return undefined
    }
    let revoked = false
    let objectUrl = null

    fetch(apiUrl(path), withAuth())
      .then(res => (res.ok ? res.blob() : Promise.reject(new Error(res.status))))
      .then(blob => {
        if (revoked) return
        objectUrl = URL.createObjectURL(blob)
        setSrc(objectUrl)
      })
      .catch(() => {
        if (!revoked) setFailed(true)
      })

    return () => {
      revoked = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [path])

  return { src, failed }
}

export default function BrowserToolCard({ part, nested = false }) {
  const toolName = part.name || ''
  const args = part.args || {}
  const isDone = part.status === 'done'
  const tur = part.toolUseResult && typeof part.toolUseResult === 'object'
    ? part.toolUseResult
    : null

  const isError =
    isDone && typeof part.result === 'string' && part.result.startsWith('Error:')

  const { src: shotSrc, failed: shotFailed } = useAuthedImage(tur?.screenshotUrl)

  const consoleErrors = useMemo(
    () => (Array.isArray(tur?.consoleErrors) ? tur.consoleErrors : []),
    [tur],
  )
  const errorCount = consoleErrors.filter(e => e.level === 'error').length

  const network = useMemo(
    () => (Array.isArray(tur?.network) ? tur.network : []),
    [tur],
  )
  const badRequests = network.filter(r => r.failed || r.status >= 400).length

  const hasBody =
    isError ||
    Boolean(tur?.screenshotUrl) ||
    Boolean(tur?.snapshot) ||
    consoleErrors.length > 0 ||
    network.length > 0 ||
    Array.isArray(tur?.tabs) ||
    tur?.value !== undefined

  const [expanded, toggleExpanded] = useStreamingExpanded(!nested && !isDone, {
    expandOnceWhen:
      isDone &&
      (Boolean(tur?.screenshotUrl) || errorCount > 0 || badRequests > 0),
  })
  const [showSnapshot, setShowSnapshot] = useState(false)

  const label = isDone
    ? DONE_LABELS[toolName] || 'Browser'
    : RUNNING_LABELS[toolName] || 'Browser'

  const title = isError
    ? part.result.replace(/^Error:\s*/, '')
    : String(tur?.message || args.url || args.ref || args.expression || '').split(
        '\n',
      )[0]

  return (
    <div className={`tool-row browser-card ${isError ? 'has-error' : ''}`}>
      <ToolCallLine
        expanded={expanded}
        onToggle={hasBody ? toggleExpanded : undefined}
        icon={ICONS[toolName] || '\u{1F310}'}
        label={label}
        title={title}
        titleTooltip={tur?.url || args.url || ''}
        subtitle={tur?.url ? compactUrl(tur.url) : null}
        meta={
          errorCount > 0 ? (
            <span className='browser-console-badge'>
              {errorCount} console error{errorCount === 1 ? '' : 's'}
            </span>
          ) : null
        }
        duration={part.duration}
        isDone={isDone}
        isError={isError}
        showSuccess={isDone && !isError}
      />

      {expanded && hasBody && (
        <div className='browser-body'>
          {isError && <div className='browser-error'>{part.result}</div>}

          {tur?.screenshotUrl && !shotFailed && (
            <div className='browser-shot'>
              {shotSrc ? (
                <img src={shotSrc} alt={tur.message || 'Browser screenshot'} />
              ) : (
                <div className='browser-shot-loading'>
                  <span className='spinner spinner-sm' />
                  Loading screenshot…
                </div>
              )}
            </div>
          )}

          {consoleErrors.length > 0 && (
            <ul className='browser-console'>
              {consoleErrors.map((entry, i) => (
                <li key={i} className={`browser-console-${entry.level}`}>
                  <span className='browser-console-level'>{entry.level}</span>
                  <span className='browser-console-text'>{entry.text}</span>
                </li>
              ))}
            </ul>
          )}

          {network.length > 0 && (
            <ul className='browser-network'>
              {network.map((r, i) => (
                <li
                  key={i}
                  className={
                    r.failed
                      ? 'browser-net-failed'
                      : r.pending
                        ? 'browser-net-pending'
                        : r.status >= 400
                          ? 'browser-net-bad'
                          : 'browser-net-ok'
                  }
                >
                  <span className='browser-net-status'>
                    {r.pending ? '···' : r.failed ? 'ERR' : r.status}
                  </span>
                  <span className='browser-net-method'>{r.method}</span>
                  <span className='browser-net-url'>{compactUrl(r.url)}</span>
                  <span className='browser-net-note'>
                    {r.pending
                      ? 'pending'
                      : r.failed
                        ? `never sent — ${r.error}`
                        : `${r.durationMs}ms`}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {tur?.value !== undefined && (
            <pre className='browser-value'>
              {JSON.stringify(tur.value, null, 2)}
            </pre>
          )}

          {Array.isArray(tur?.tabs) && (
            <ul className='browser-tabs'>
              {tur.tabs.map(tab => (
                <li
                  key={tab.targetId}
                  className={tab.current ? 'is-current' : ''}
                >
                  <span className='browser-tab-title'>
                    {tab.title || '(untitled)'}
                  </span>
                  <span className='browser-tab-url'>{compactUrl(tab.url)}</span>
                </li>
              ))}
            </ul>
          )}

          {tur?.snapshot && (
            <div className='browser-snapshot'>
              <button
                type='button'
                className='browser-snapshot-toggle'
                onClick={e => {
                  e.stopPropagation()
                  setShowSnapshot(v => !v)
                }}
              >
                {showSnapshot ? 'Hide' : 'Show'} page structure
              </button>
              {showSnapshot && (
                <>
                  <pre className='browser-snapshot-tree'>{tur.snapshot}</pre>
                  <CopyButton text={tur.snapshot} label='Copy' inline />
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
