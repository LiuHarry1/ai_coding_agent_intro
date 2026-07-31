import React, { useMemo } from 'react'
import CopyButton from './CopyButton.jsx'
import ToolRowHeader from './ToolRowHeader.jsx'
import { FileIcon } from './workspace-ide/icons.jsx'
import { useStreamingExpanded } from '../lib/use-streaming-expanded.js'
import {
  fileName,
  shortDisplayPath,
  shortGlobPattern,
  truncateEnd,
} from '../lib/utils.js'

/**
 * Cursor-style Grep — dense search-panel from `toolUseResult` only.
 */

function splitPathParts(filePath) {
  const norm = String(filePath || '').replace(/\\/g, '/')
  const base = fileName(norm) || norm
  const dir = norm.includes('/')
    ? norm.slice(0, norm.length - base.length).replace(/\/$/, '')
    : ''
  return { base, dir, full: norm }
}

/**
 * Parse one ripgrep content line (match `:` or context `-`).
 *   path:line:text | path:line-text | line:text | line-text
 */
function parseRgContentLine(raw, fallbackPath) {
  if (!raw || raw === '--') return null
  if (raw.startsWith('[Showing results with pagination')) return null
  if (raw === 'No matches found') return null

  const m = raw.match(/^(?:(.+?):)?(\d+)([:\-])(.*)$/)
  if (!m) return null
  const filePath = m[1] || fallbackPath || '(file)'
  return {
    file: filePath,
    lineNo: m[2],
    kind: m[3] === ':' ? 'match' : 'context',
    text: m[4] ?? '',
  }
}

function parseContentLines(content, fallbackPath) {
  const groups = new Map()
  if (!content || content === 'No matches found') return []
  for (const raw of content.split('\n')) {
    const row = parseRgContentLine(raw, fallbackPath)
    if (!row) continue
    if (!groups.has(row.file)) groups.set(row.file, [])
    groups.get(row.file).push(row)
  }
  return [...groups.entries()].map(([file, matches]) => ({ file, matches }))
}

function fromToolUseResult(toolUseResult) {
  if (!toolUseResult || typeof toolUseResult !== 'object') return null
  if (!Array.isArray(toolUseResult.filenames) && !Array.isArray(toolUseResult.files)) {
    return null
  }
  const mode = toolUseResult.mode || 'files_with_matches'
  const files = Array.isArray(toolUseResult.files)
    ? toolUseResult.files
    : (toolUseResult.filenames || []).map(p => ({
        path: p,
        matchCount: 1,
      }))
  return {
    mode,
    files,
    numFiles: toolUseResult.numFiles ?? files.length,
    numMatches: toolUseResult.numMatches,
    numLines: toolUseResult.numLines,
    content: toolUseResult.content,
    empty:
      (toolUseResult.numFiles ?? files.length) === 0 &&
      !(toolUseResult.content && toolUseResult.content !== 'No matches found'),
  }
}

function HighlightedText({ text, pattern, caseInsensitive }) {
  if (!pattern || !text) return text
  try {
    const re = new RegExp(pattern, caseInsensitive ? 'gi' : 'g')
    const parts = []
    let last = 0
    let key = 0
    for (const m of String(text).matchAll(re)) {
      if (m.index > last) {
        parts.push(
          <React.Fragment key={key++}>{text.slice(last, m.index)}</React.Fragment>,
        )
      }
      parts.push(
        <mark key={key++} className='grep-hl'>
          {m[0]}
        </mark>,
      )
      last = m.index + m[0].length
    }
    if (parts.length === 0) return text
    if (last < text.length) {
      parts.push(<React.Fragment key={key++}>{text.slice(last)}</React.Fragment>)
    }
    return parts
  } catch {
    return text
  }
}

function FilePathLabel({ path: filePath }) {
  const { base, dir, full } = splitPathParts(filePath)
  return (
    <span className='grep-path' title={full}>
      <FileIcon size={12} />
      <span className='grep-file-name'>{base}</span>
      {dir ? <span className='grep-file-dir'>{dir}</span> : null}
    </span>
  )
}

function countContentStats(groups) {
  let matches = 0
  for (const g of groups) {
    for (const row of g.matches) {
      if (row.kind === 'match') matches += 1
    }
  }
  return { matchN: matches, fileN: groups.length }
}

export default function GrepCard({ part, nested = false }) {
  const args = part.args || {}
  const result = part.result
  const isDone = part.status === 'done'
  const isError =
    isDone &&
    (part.isError === true ||
      (typeof result === 'string' && result.startsWith('Error:')))

  const parsed = useMemo(
    () => fromToolUseResult(part.toolUseResult),
    [part.toolUseResult],
  )

  const contentGroups = useMemo(() => {
    if (!parsed || parsed.mode !== 'content') return []
    return parseContentLines(parsed.content, args.path)
  }, [parsed, args.path])

  const hasBody =
    isError ||
    (!!parsed &&
      (parsed.empty ||
        (parsed.mode === 'content' && contentGroups.length > 0) ||
        ((parsed.mode === 'files_with_matches' || parsed.mode === 'count') &&
          parsed.files.length > 0)))

  const [expanded, toggleExpanded] = useStreamingExpanded(!nested && !isDone, {
    expandOnceWhen:
      isDone &&
      ((isError && !!result) || (!!parsed && !parsed.empty && hasBody)),
  })
  // Honor expand state only — do not force-open when isDone.
  const showBody = expanded && hasBody

  const pattern = args.pattern || ''
  const displayPattern = pattern ? truncateEnd(pattern, 44) : ''
  const filterBits = []
  const shortGlob = shortGlobPattern(args.glob)
  const shortPath =
    args.path && args.path !== '.' ? shortDisplayPath(args.path) : null
  if (shortPath) filterBits.push(`in ${shortPath}`)
  if (shortGlob) filterBits.push(shortGlob)
  if (args.type) filterBits.push(`type:${args.type}`)

  const filterTooltip = [
    args.glob && `glob: ${args.glob}`,
    args.type && `type: ${args.type}`,
    args.path && args.path !== '.' && `path: ${args.path}`,
  ]
    .filter(Boolean)
    .join('\n')

  let countLabel = null
  if (isDone && !isError && parsed && !parsed.empty) {
    if (parsed.mode === 'files_with_matches' || parsed.mode === 'count') {
      const n = parsed.numFiles ?? parsed.files.length
      if (n > 0) {
        const total =
          parsed.numMatches ??
          parsed.files.reduce((s, f) => s + (f.matchCount || 0), 0)
        countLabel =
          parsed.mode === 'count' || total > n
            ? `${total} ${total === 1 ? 'match' : 'matches'} in ${n} ${n === 1 ? 'file' : 'files'}`
            : parsed.mode === 'files_with_matches' && total > 0
              ? `${total} ${total === 1 ? 'match' : 'matches'} in ${n} ${n === 1 ? 'file' : 'files'}`
              : `${n} ${n === 1 ? 'file' : 'files'}`
      }
    } else if (parsed.mode === 'content') {
      const { matchN, fileN } = countContentStats(contentGroups)
      if (matchN > 0) {
        countLabel = `${matchN} ${matchN === 1 ? 'match' : 'matches'} in ${fileN} ${fileN === 1 ? 'file' : 'files'}`
      }
    }
  }

  const subtitle = filterBits.length > 0 ? filterBits.join(' \u00B7 ') : null
  const emptyHint =
    isDone && !isError && parsed?.empty ? 'No matches' : null
  const caseInsensitive = !!args.case_insensitive
  // Single-file search: path already in subtitle — skip repeating file header.
  const hideFileHeaders =
    contentGroups.length === 1 &&
    !!args.path &&
    args.path !== '.'

  return (
    <div className={`tool-row grep-card ${isError ? 'has-error' : ''}`}>
      <ToolRowHeader
        expanded={expanded && hasBody}
        onToggle={hasBody ? toggleExpanded : undefined}
        showChevron={hasBody}
        label='Grepped'
        title={displayPattern ? `\u201C${displayPattern}\u201D` : 'grep\u2026'}
        titleTooltip={
          [pattern && `pattern: ${pattern}`, filterTooltip]
            .filter(Boolean)
            .join('\n') || undefined
        }
        subtitle={subtitle}
        subtitleTooltip={filterTooltip || undefined}
        meta={
          countLabel ? (
            <span className='grep-count-label'>{countLabel}</span>
          ) : null
        }
        duration={part.duration}
        isDone={isDone}
        isError={isError}
        emptyHint={emptyHint}
        actions={
          isDone &&
          !isError &&
          typeof result === 'string' &&
          result.length > 0 ? (
            <CopyButton text={result} label='Copy' inline />
          ) : null
        }
      />

      {showBody &&
        isDone &&
        !isError &&
        parsed &&
        !parsed.empty &&
        (parsed.mode === 'files_with_matches' || parsed.mode === 'count') && (
          <ul className='grep-results'>
            {parsed.files.map(f => (
              <li key={f.path} className='grep-file-row'>
                <FilePathLabel path={f.path} />
                {parsed.mode === 'count' && f.matchCount != null ? (
                  <span className='grep-file-count'>{f.matchCount}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}

      {showBody &&
        isDone &&
        !isError &&
        parsed?.mode === 'content' &&
        contentGroups.length > 0 && (
          <div className='grep-results'>
            {contentGroups.map(g => (
              <div key={g.file} className='grep-file-block'>
                {!hideFileHeaders && (
                  <div className='grep-file-header'>
                    <FilePathLabel path={g.file} />
                  </div>
                )}
                {g.matches.map((m, i) => (
                  <div
                    key={`${g.file}:${m.lineNo}:${m.kind}:${i}`}
                    className={`grep-match-line grep-match-line--${m.kind}`}
                  >
                    <span className='grep-line-no'>{m.lineNo}</span>
                    <span className='grep-line-text'>
                      {m.kind === 'match' ? (
                        <HighlightedText
                          text={m.text}
                          pattern={pattern}
                          caseInsensitive={caseInsensitive}
                        />
                      ) : (
                        m.text
                      )}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}

      {showBody && isDone && !isError && parsed?.empty && (
        <div className='grep-empty'>No matches</div>
      )}

      {showBody && isError && (
        <div className='tool-row-body tool-row-body--error'>{result}</div>
      )}
    </div>
  )
}
