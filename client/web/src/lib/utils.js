/**
 * Extract filename from a full file path.
 */
export function fileName(filePath) {
  if (!filePath) return null
  const parts = filePath.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1]
}

/** Truncate at the end — good for regex patterns and globs. */
export function truncateEnd(str, maxLen) {
  if (!str || str.length <= maxLen) return str
  return `${str.slice(0, maxLen - 1)}…`
}

/** Show a compact path: last 1–2 segments, or basename when very long. */
export function shortDisplayPath(filePath, maxLen = 36) {
  if (!filePath) return null
  const norm = String(filePath).replace(/\\/g, '/')
  if (norm.length <= maxLen) return norm
  const parts = norm.split('/').filter(Boolean)
  if (parts.length >= 2) {
    const tail = parts.slice(-2).join('/')
    if (tail.length <= maxLen) return tail
  }
  const base = parts[parts.length - 1] || norm
  return base.length <= maxLen ? base : truncateEnd(base, maxLen)
}

/** Summarize long or negated glob strings for tool-row headers. */
export function shortGlobPattern(glob, maxLen = 28) {
  if (!glob) return null
  const g = glob.trim()
  if (g.length <= maxLen) return g
  if (g.startsWith('![')) {
    const count = g
      .slice(2)
      .replace(/\]$/, '')
      .split(',')
      .filter(Boolean).length
    return count > 1 ? `${count} exclusions` : truncateEnd(g, maxLen)
  }
  if (g.startsWith('!')) return truncateEnd(g, maxLen)
  const parts = g.split(/[\s,]+/).filter(Boolean)
  if (parts.length > 1) return `${parts.length} patterns`
  return truncateEnd(g, maxLen)
}

/**
 * Format a timestamp to relative time string.
 */
export function relativeTime(ts) {
  if (!ts) return ''
  const diff = Date.now() - ts
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d ago`
  return new Date(ts).toLocaleDateString()
}

/**
 * Format milliseconds as human-readable duration.
 */
export function formatDuration(ms) {
  if (!ms) return null
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * "N chars" / "N.Nk chars" — used by every tool card to summarize byte
 * counts in headers (live streaming progress, result-size labels, etc).
 * Kept in one place so the threshold + precision stay consistent.
 */
export function formatBytes(n) {
  if (n == null) return ''
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k chars`
  return `${n} chars`
}

/**
 * Did this tool call fail? Looks at both the result string conventions our
 * backend uses (`Error:` prefix for thrown errors, `[exit code: N]` for
 * bash) and tool-name-specific heuristics. Single source of truth so
 * BashCard / ReadFileCard / WebSearchCard / WebFetchCard / SubagentCard / ToolCallCard
 * agree on what counts as an error.
 */
export function detectError(name, result) {
  if (typeof result !== 'string') return false
  if (result.startsWith('Error:')) return true
  const exitMatch = result.match(/\[exit code:\s*(\d+)\]/)
  if (exitMatch && exitMatch[1] !== '0') return true
  // Some bash-like tools embed exit codes inline rather than in brackets.
  if (
    (name === 'Bash' ||
      name === 'PowerShell' ||
      name?.includes('command') ||
      name?.includes('run')) &&
    /exit code:\s*[1-9]/.test(result)
  ) {
    return true
  }
  return false
}
