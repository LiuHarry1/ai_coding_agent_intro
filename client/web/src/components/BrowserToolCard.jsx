import React, { useMemo } from 'react'
import ToolChrome from './ToolChrome.jsx'
import { useAuthedImage } from '../hooks/useAuthedImage.js'
import { useToolDensityExpand } from '../lib/use-tool-density-expand.js'
import { getToolDensityKind } from '../lib/tool-registry-meta.js'
import {
  BROWSER_CLICK,
  BROWSER_CONSOLE,
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
  BROWSER_GET_TEXT,
  BROWSER_TABS,
  BROWSER_TYPE,
  BROWSER_WAIT_FOR,
  BROWSER_LOCK,
  BROWSER_DRAG,
  BROWSER_RESIZE,
  BROWSER_WAIT_FOR_DOWNLOAD,
  BROWSER_HIGHLIGHT,
  BROWSER_GET_BOUNDING_BOX,
  BROWSER_CDP,
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
  [BROWSER_GET_TEXT]: '\u{1F4C4}',
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
  [BROWSER_LOCK]: '\u{1F512}',
  [BROWSER_DRAG]: '\u{2194}',
  [BROWSER_RESIZE]: '\u{2922}',
  [BROWSER_WAIT_FOR_DOWNLOAD]: '\u{1F4E5}',
  [BROWSER_HIGHLIGHT]: '\u{2728}',
  [BROWSER_GET_BOUNDING_BOX]: '\u{25A3}',
  [BROWSER_CDP]: '\u{2699}',
}

const RUNNING_LABELS = {
  [BROWSER_NAVIGATE]: 'Opening page',
  [BROWSER_SNAPSHOT]: 'Reading page',
  [BROWSER_GET_TEXT]: 'Reading text',
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
  [BROWSER_LOCK]: 'Locking browser',
  [BROWSER_DRAG]: 'Dragging',
  [BROWSER_RESIZE]: 'Resizing viewport',
  [BROWSER_WAIT_FOR_DOWNLOAD]: 'Waiting for download',
  [BROWSER_HIGHLIGHT]: 'Highlighting',
  [BROWSER_GET_BOUNDING_BOX]: 'Measuring element',
  [BROWSER_CDP]: 'Sending CDP command',
}

const DONE_LABELS = {
  [BROWSER_NAVIGATE]: 'Opened page',
  [BROWSER_SNAPSHOT]: 'Read page',
  [BROWSER_GET_TEXT]: 'Read text',
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
  [BROWSER_LOCK]: 'Browser lock',
  [BROWSER_DRAG]: 'Dragged',
  [BROWSER_RESIZE]: 'Resized viewport',
  [BROWSER_WAIT_FOR_DOWNLOAD]: 'Download saved',
  [BROWSER_HIGHLIGHT]: 'Highlighted',
  [BROWSER_GET_BOUNDING_BOX]: 'Bounding box',
  [BROWSER_CDP]: 'CDP command',
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

/** One-line header copy — never mount multi-KB snapshots in the title row. */
function compactBrowserTitle(raw) {
  if (raw == null || raw === '') return ''
  let text = String(raw)
  const snapIdx = text.indexOf('Current page snapshot')
  if (snapIdx >= 0) text = text.slice(0, snapIdx)
  text = text.split('\n')[0].trim()
  if (text.length > 160) text = `${text.slice(0, 157)}\u2026`
  return text
}

/** Expanded error body — strip embedded snapshot text, keep the message. */
function browserErrorBody(raw) {
  if (raw == null || raw === '') return ''
  let text = String(raw).replace(/^Error:\s*/, '')
  const snapIdx = text.indexOf('Current page snapshot')
  if (snapIdx >= 0) text = text.slice(0, snapIdx)
  text = text.trim()
  if (text.length > 480) text = `${text.slice(0, 477)}\u2026`
  return text
}

function BrowserToolCard({ part, nested = false }) {
  const toolName = part.name || ''
  const args = part.args || {}
  const isDone = part.status === 'done'
  const tur = part.toolUseResult && typeof part.toolUseResult === 'object'
    ? part.toolUseResult
    : null

  const isError =
    isDone &&
    (part.isError === true ||
      (typeof part.result === 'string' && part.result.startsWith('Error:')))

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

  const hasBody =
    isError ||
    Boolean(tur?.screenshotUrl) ||
    Boolean(tur?.pageState) ||
    consoleErrors.length > 0 ||
    network.length > 0 ||
    Array.isArray(tur?.tabs) ||
    tur?.value !== undefined

  const [expanded, toggleExpanded, chevron] = useToolDensityExpand(
    getToolDensityKind(toolName) || 'explore-line',
    {
      isDone,
      // Stay collapsed on error — snapshot text used to land in the error body.
      isError: false,
      nested,
      hasBody,
    },
  )

  const label = isDone
    ? DONE_LABELS[toolName] || 'Browser'
    : RUNNING_LABELS[toolName] || 'Browser'

  const title = isError
    ? compactBrowserTitle(part.result?.replace(/^Error:\s*/, ''))
    : compactBrowserTitle(
        tur?.message || args.url || args.ref || args.expression || '',
      )

  const errorDetail =
    isError && typeof part.result === 'string'
      ? browserErrorBody(part.result)
      : null

  const pageState = tur?.pageState && typeof tur.pageState === 'object' ? tur.pageState : null

  return (
    <ToolChrome
      variant='browser-card'
      nested={nested}
      isError={isError}
      isDone={isDone}
      expanded={expanded}
      onToggle={hasBody ? toggleExpanded : undefined}
      hasBody={hasBody}
      showChevron={chevron.showChevron}
      chevronSlot={chevron.chevronSlot}
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
      duration={undefined}
      showSuccess={false}
    >
      <div className='browser-body'>
          {errorDetail && <div className='browser-error'>{errorDetail}</div>}

          {pageState && (
            <div className='browser-page-state'>
              <span>
                {pageState.mode || 'snapshot'}
                {typeof pageState.chars === 'number' ? ` · ${pageState.chars} chars` : ''}
                {pageState.truncated ? ' · truncated' : ''}
              </span>
              {pageState.artifactPath ? (
                <span className='browser-page-state-path' title={pageState.artifactPath}>
                  {pageState.artifactPath}
                </span>
              ) : null}
            </div>
          )}

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
              {typeof tur.value === 'string'
                ? tur.value.length > 400
                  ? `${tur.value.slice(0, 399)}\u2026`
                  : tur.value
                : (() => {
                    try {
                      const raw = JSON.stringify(tur.value, null, 2)
                      return raw.length > 400
                        ? `${raw.slice(0, 399)}\u2026`
                        : raw
                    } catch {
                      return String(tur.value)
                    }
                  })()}
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
        </div>
    </ToolChrome>
  )
}

export default React.memo(BrowserToolCard)
