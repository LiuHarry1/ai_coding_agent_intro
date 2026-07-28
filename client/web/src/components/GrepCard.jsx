import React, { useMemo } from 'react'
import CopyButton from './CopyButton.jsx'
import ToolRowHeader from './ToolRowHeader.jsx'
import { useStreamingExpanded } from '../lib/use-streaming-expanded.js'
import {
  shortDisplayPath,
  shortGlobPattern,
  truncateEnd,
} from '../lib/utils.js'

/**
 * Cursor-style card for the `grep` tool.
 *
 * Header shape (varies by output_mode):
 *   Grepped   "pattern"   *.ts · 5 files
 *   Grepped   "pattern"   12 matches in 4 files       (content mode)
 *   Grepped   "pattern"   42 occurrences across 3 files  (count mode)
 *
 * Result-string shapes (see src/tools/GrepTool/GrepTool.ts:execute):
 *   files_with_matches: "Found N file(s) [limit: …]\n<path>\n<path>\n…"
 *                       or "No files found".
 *   content:            "<path>:<line?>:<text>\n…" (+ pagination footer).
 *   count:              "<path>:N\n…\n\nFound X total occurrences across Y files…"
 */

function parseFilesWithMatches(result) {
  const lines = result.split('\n')
  // First line is "Found N file(s) …"; everything after is paths.
  const header = lines[0] || ''
  const m = header.match(/^Found\s+(\d+)\s+files?/)
  const fileCount = m ? +m[1] : null
  const files = lines.slice(1).filter(Boolean)
  return { kind: 'files', fileCount, files }
}

function parseContent(result, fallbackPath) {
  // Each line is `<path>:<line_no?>:<content>` — group by path so we can
  // render a Cursor-style "file → matches" tree.
  //
  // Special case: when ripgrep searches a single file it omits the
  // filename prefix and emits `<line_no>:<content>` directly. We detect
  // this (first colon-separated token is purely numeric) and attribute
  // those rows to `fallbackPath` (the `path` argument the user passed).
  const lines = result.split('\n')
  const groups = new Map()
  let totalMatches = 0
  let paginationFooter = ''
  for (const raw of lines) {
    if (!raw) continue
    if (raw.startsWith('[Showing results with pagination')) {
      paginationFooter = raw
      continue
    }
    if (raw === 'No matches found') {
      return {
        kind: 'content',
        groups: [],
        totalMatches: 0,
        paginationFooter,
        empty: true,
      }
    }
    const firstColon = raw.indexOf(':')
    if (firstColon <= 0) continue
    const head = raw.slice(0, firstColon)
    const rest = raw.slice(firstColon + 1)

    let filePath
    let lineNo = null
    let text
    if (/^\d+$/.test(head)) {
      // Single-file rg output: `<line_no>:<text>`
      filePath = fallbackPath || '(file)'
      lineNo = head
      text = rest
    } else {
      filePath = head
      // rest may be `<line_no>:<text>` or just `<text>`.
      const secondColon = rest.indexOf(':')
      text = rest
      if (secondColon > 0 && /^\d+$/.test(rest.slice(0, secondColon))) {
        lineNo = rest.slice(0, secondColon)
        text = rest.slice(secondColon + 1)
      }
    }
    if (!groups.has(filePath)) groups.set(filePath, [])
    groups.get(filePath).push({ lineNo, text })
    totalMatches += 1
  }
  return {
    kind: 'content',
    groups: [...groups.entries()].map(([file, matches]) => ({ file, matches })),
    totalMatches,
    paginationFooter,
    empty: groups.size === 0,
  }
}

function parseCount(result) {
  const summaryIdx = result.lastIndexOf('\n\nFound ')
  const body = summaryIdx >= 0 ? result.slice(0, summaryIdx) : result
  const summary = summaryIdx >= 0 ? result.slice(summaryIdx + 2) : ''
  const entries = body
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const i = line.lastIndexOf(':')
      if (i <= 0) return null
      return { file: line.slice(0, i), count: line.slice(i + 1) }
    })
    .filter(Boolean)
  return { kind: 'count', entries, summary }
}

function parseResult(result, mode, fallbackPath) {
  if (typeof result !== 'string' || result.length === 0) {
    return { kind: 'empty' }
  }
  if (result.startsWith('Error:')) return { kind: 'error' }
  if (
    result.trim() === 'No files found' ||
    result.trim() === 'No matches found'
  ) {
    return {
      kind: mode === 'content' ? 'content' : 'files',
      empty: true,
      files: [],
      groups: [],
      totalMatches: 0,
    }
  }
  if (mode === 'content') return parseContent(result, fallbackPath)
  if (mode === 'count') return parseCount(result)
  return parseFilesWithMatches(result)
}

export default function GrepCard({ part, nested = false }) {
  const args = part.args || {}
  const result = part.result
  const isDone = part.status === 'done'
  const isError =
    isDone && typeof result === 'string' && result.startsWith('Error:')
  const mode = args.output_mode || 'files_with_matches'

  const parsed = useMemo(
    () => parseResult(result, mode, args.path),
    [result, mode, args.path],
  )

  // Nested (inside Explored/Subagent): stay collapsed — parent owns density.
  const [expanded, toggleExpanded] = useStreamingExpanded(!nested && !isDone)

  const pattern = args.pattern || ''
  const displayPattern = pattern ? truncateEnd(pattern, 44) : ''
  const filterBits = []
  const shortGlob = shortGlobPattern(args.glob)
  const shortPath =
    args.path && args.path !== '.' ? shortDisplayPath(args.path) : null
  if (shortGlob) filterBits.push(shortGlob)
  if (args.type) filterBits.push(`type:${args.type}`)
  if (shortPath) filterBits.push(shortPath)

  const filterTooltip = [
    args.glob && `glob: ${args.glob}`,
    args.type && `type: ${args.type}`,
    args.path && args.path !== '.' && `path: ${args.path}`,
  ]
    .filter(Boolean)
    .join('\n')

  // Count sits in `meta` so it stays visible when filters are long.
  let countLabel = null
  if (isDone && !isError) {
    if (parsed.kind === 'files') {
      const n = parsed.fileCount ?? parsed.files?.length ?? 0
      if (n > 0) countLabel = `${n} ${n === 1 ? 'file' : 'files'}`
    } else if (parsed.kind === 'content') {
      const fileN = parsed.groups?.length ?? 0
      const matchN = parsed.totalMatches ?? 0
      if (matchN > 0) {
        countLabel = `${matchN} ${matchN === 1 ? 'match' : 'matches'} in ${fileN} ${fileN === 1 ? 'file' : 'files'}`
      }
    } else if (parsed.kind === 'count') {
      countLabel =
        parsed.summary?.replace(/\.$/, '').replace(/^Found\s+/, '') || null
    }
  }
  const subtitle = filterBits.length > 0 ? filterBits.join(' \u00B7 ') : null

  const emptyHint =
    isDone && !isError && (parsed.empty || parsed.kind === 'empty')
      ? 'No matches'
      : null

  return (
    <div className={`tool-row grep-card ${isError ? 'has-error' : ''}`}>
      <ToolRowHeader
        expanded={expanded}
        onToggle={toggleExpanded}
        showChevron={false}
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

      {expanded &&
        isDone &&
        !isError &&
        parsed.kind === 'files' &&
        !parsed.empty && (
          <ul className='glob-file-list'>
            {(parsed.files || []).map(f => (
              <li key={f} className='glob-file-item' title={f}>
                <span className='glob-file-icon' aria-hidden='true'>
                  {'\u{1F4C4}'}
                </span>
                <span className='glob-file-path'>{f}</span>
              </li>
            ))}
          </ul>
        )}

      {expanded &&
        isDone &&
        !isError &&
        parsed.kind === 'content' &&
        !parsed.empty && (
          <div className='grep-content-body'>
            {parsed.groups.map(g => (
              <div key={g.file} className='grep-file-group'>
                <div className='grep-file-header' title={g.file}>
                  <span className='glob-file-icon' aria-hidden='true'>
                    {'\u{1F4C4}'}
                  </span>
                  <span className='glob-file-path'>{g.file}</span>
                  <span className='grep-match-count'>
                    {g.matches.length}{' '}
                    {g.matches.length === 1 ? 'match' : 'matches'}
                  </span>
                </div>
                <pre className='grep-match-lines'>
                  {g.matches
                    .map(m =>
                      m.lineNo
                        ? `${m.lineNo.padStart(5)} │ ${m.text}`
                        : `      │ ${m.text}`,
                    )
                    .join('\n')}
                </pre>
              </div>
            ))}
            {parsed.paginationFooter && (
              <div className='grep-footer'>{parsed.paginationFooter}</div>
            )}
          </div>
        )}

      {expanded && isDone && !isError && parsed.kind === 'count' && (
        <div className='grep-content-body'>
          <ul className='glob-file-list'>
            {parsed.entries.map(e => (
              <li key={e.file} className='glob-file-item' title={e.file}>
                <span className='glob-file-icon' aria-hidden='true'>
                  {'\u{1F4C4}'}
                </span>
                <span className='glob-file-path'>{e.file}</span>
                <span className='grep-match-count'>{e.count}</span>
              </li>
            ))}
          </ul>
          {parsed.summary && (
            <div className='grep-footer'>{parsed.summary}</div>
          )}
        </div>
      )}

      {expanded &&
        isDone &&
        !isError &&
        (parsed.empty || parsed.kind === 'empty') && (
          <div className='tool-row-body'>
            No matches for <code>{pattern}</code>.
          </div>
        )}

      {expanded && isError && (
        <div className='tool-row-body tool-row-body--error'>{result}</div>
      )}
    </div>
  )
}
