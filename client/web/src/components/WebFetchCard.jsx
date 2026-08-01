import React, { useState, useMemo } from 'react'
import CopyButton from './CopyButton.jsx'
import ToolCallLine from './ToolCallLine.jsx'
import { formatBytes } from '../lib/utils.js'
import { parseMcpToolName } from '../lib/tool-kind.js'
import { normalizeFetchResult, compactFetchError } from '../lib/fetch-result.js'
import { useStreamingExpanded } from '../lib/use-streaming-expanded.js'

/**
 * Dedicated card for URL-fetch tools:
 * - built-in `web_fetch` (JSON article payload)
 * - MCP fetch tools like `mcp_server_fetch` (markdown / content blocks)
 *
 * Cursor show a compact row (action + URL/title), not
 * `tool_name {"url":…}` plus an empty Arguments panel.
 */

const PREVIEW_CHARS = 600

function hostname(url) {
  if (typeof url !== 'string') return ''
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** Compact URL for the header: `thepaper.cn/newsDetail_forward_…` */
function urlHeadline(url) {
  if (typeof url !== 'string') return '…'
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^www\./, '')
    const path = (u.pathname + u.search).replace(/\/$/, '') || ''
    if (!path || path === '/') return host
    const full = `${host}${path}`
    return full.length > 72 ? `${full.slice(0, 69)}…` : full
  } catch {
    return url.length > 72 ? `${url.slice(0, 69)}…` : url
  }
}

export default function WebFetchCard({ part, nested = false }) {
  const toolName = part.name || ''
  const args = part.args || {}
  const result = part.result
  const requestUrl = args.url || ''
  const isDone = part.status === 'done'

  const { server: mcpServer } = parseMcpToolName(toolName)

  const normalized = useMemo(() => {
    if (part.toolUseResult && typeof part.toolUseResult === 'object') {
      const tur = part.toolUseResult
      return {
        text: tur.text || '',
        title: tur.title || '',
        excerpt: tur.excerpt,
        url: tur.url || requestUrl,
        note: tur.note,
        error: undefined,
      }
    }
    return normalizeFetchResult(result, requestUrl)
  }, [part.toolUseResult, result, requestUrl])

  const isError = isDone && Boolean(normalized.error)
  const articleUrl = normalized.url || requestUrl
  const text = normalized.text || ''
  const title = normalized.title || ''
  const host = hostname(articleUrl)

  // Expanded only while running; collapses on done (user can still click).
  const [expanded, toggleExpanded] = useStreamingExpanded(!nested && !isDone)
  const [showFull, setShowAll] = useState(false)

  const headline = isDone && title ? title : urlHeadline(articleUrl)
  const subtitle =
    isDone && title && host ? host : mcpServer ? `via ${mcpServer}` : null

  const previewText = showFull ? text : text.slice(0, PREVIEW_CHARS)
  const hasMore = text.length > PREVIEW_CHARS
  const resultSize =
    text.length || (typeof result === 'string' ? result.length : 0)

  return (
    <div className={`tool-row web-fetch-card ${isError ? 'has-error' : ''}`}>
      <ToolCallLine
        expanded={expanded}
        onToggle={toggleExpanded}
        icon={'\u{1F310}'}
        label='Web Fetch'
        title={headline}
        titleTooltip={articleUrl || requestUrl}
        subtitle={subtitle}
        meta={
          isDone && resultSize > 0 ? (
            <span className='web-fetch-meta'>{formatBytes(resultSize)}</span>
          ) : null
        }
        duration={part.duration}
        isDone={isDone}
        isError={isError}
        actions={
          isDone && !isError && text ? (
            <CopyButton text={text} label='Copy' inline />
          ) : null
        }
      />

      {expanded && (
        <div className='web-fetch-body'>
          {isError && (
            <div className='web-fetch-error'>
              {compactFetchError(normalized.error, articleUrl || requestUrl)}
            </div>
          )}

          {!isError && articleUrl && (
            <a
              href={articleUrl}
              target='_blank'
              rel='noreferrer noopener'
              className='web-fetch-link'
              title={articleUrl}
              onClick={e => e.stopPropagation()}
            >
              {urlHeadline(articleUrl)}
            </a>
          )}

          {!isError && normalized.excerpt && (
            <div className='web-fetch-excerpt'>{normalized.excerpt}</div>
          )}

          {!isError && normalized.note && (
            <div className='web-fetch-note'>{normalized.note}</div>
          )}

          {!isError && text && (
            <div className='web-fetch-text'>
              {previewText}
              {hasMore && !showFull ? '…' : ''}
            </div>
          )}

          {!isError && hasMore && (
            <button
              type='button'
              className='web-fetch-more'
              onClick={e => {
                e.stopPropagation()
                setShowAll(v => !v)
              }}
            >
              {showFull
                ? 'Show less'
                : `Show full (${formatBytes(text.length)})`}
            </button>
          )}

          {!isError && !text && isDone && typeof result === 'string' && (
            <pre className='web-fetch-raw'>{result}</pre>
          )}

          {!isError && !isDone && (
            <div className='web-fetch-loading'>
              <span className='spinner spinner-sm' />
              Fetching…
            </div>
          )}
        </div>
      )}
    </div>
  )
}
