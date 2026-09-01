/**
 * Strip heavy tool payloads before they enter React state.
 *
 * Legacy belt-and-suspenders after server-side wire projection:
 * - browser_* snapshots / embedded CDP dumps
 * - Read toolUseResult embedding PDF/image base64
 *
 * Not a general truncator — bash / MCP text stays intact unless it still
 * carries a snapshot marker or a data-URL.
 */

const SNAPSHOT_MARKERS = [
  '\nPage snapshot:\n',
  '\nPage snapshot:',
  '\nCurrent page snapshot',
  'Current page snapshot (use these refs',
  'Current page snapshot:',
]

/** Last-resort cap after snapshot/base64 strip (not the happy path). */
const MAX_RESULT_CHARS = 16_000
const MAX_BROWSER_MESSAGE_CHARS = 200
const MAX_BROWSER_VALUE_CHARS = 240
const MAX_GENERIC_STRING = 2_000
const MAX_TUR_JSON_CHARS = 8_192

function isBrowserTool(name) {
  return typeof name === 'string' && name.startsWith('browser_')
}

function isReadTool(name) {
  return name === 'Read'
}

function truncateString(text, max) {
  if (typeof text !== 'string' || text.length <= max) return text
  return `${text.slice(0, max - 1)}\u2026`
}

function stripSnapshotAndDataUrls(text) {
  if (typeof text !== 'string') return text
  let next = text
  for (const marker of SNAPSHOT_MARKERS) {
    const idx = next.indexOf(marker)
    if (idx >= 0) {
      next = next.slice(0, idx).trimEnd()
      break
    }
  }
  if (/data:image\/[a-zA-Z0-9+.-]+;base64,/.test(next)) {
    next = next.replace(
      /data:image\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=\s]+/g,
      '[image omitted]',
    )
  }
  return next
}

/**
 * @param {unknown} result
 * @returns {unknown}
 */
export function sanitizeToolResultText(result) {
  if (typeof result !== 'string') return result
  const stripped = stripSnapshotAndDataUrls(result)
  if (stripped.length > MAX_RESULT_CHARS) {
    return truncateString(stripped, MAX_GENERIC_STRING)
  }
  return stripped
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function sanitizeBrowserValue(value) {
  if (value === undefined) return undefined
  if (typeof value === 'string') {
    return truncateString(value, MAX_BROWSER_VALUE_CHARS)
  }
  try {
    const raw = JSON.stringify(value)
    if (raw == null) return undefined
    if (raw.length <= MAX_BROWSER_VALUE_CHARS) return value
    return truncateString(raw, MAX_BROWSER_VALUE_CHARS)
  } catch {
    return '[unserializable]'
  }
}

/**
 * Read cards only need path + line range / size — never file bodies or base64.
 * @param {Record<string, unknown>} tur
 */
function sanitizeReadToolUseResult(tur) {
  const next = { ...tur }
  const file =
    next.file && typeof next.file === 'object' ? { ...next.file } : null
  if (!file) return next

  if (typeof file.content === 'string') {
    file.content = file.content.length > 0 ? ' ' : ''
  }
  if (typeof file.base64 === 'string' && file.base64.length > 0) {
    file.base64 = ''
  }
  if (typeof file.text === 'string' && file.text.length > 500) {
    file.text = truncateString(file.text, 500)
  }
  if (Array.isArray(file.cells) && file.cells.length > 0) {
    file.cells = []
  }
  next.file = file
  return next
}

/**
 * @param {unknown} tur
 * @param {{ browser?: boolean }} [opts]
 * @returns {unknown}
 */
export function sanitizeToolUseResult(tur, opts = {}) {
  if (!tur || typeof tur !== 'object') return tur

  let next = { ...tur }
  let changed = false
  const browser = Boolean(opts.browser)

  if (typeof next.type === 'string' && next.file && typeof next.file === 'object') {
    const file = next.file
    const needsStrip =
      (typeof file.content === 'string' && file.content.length > 1) ||
      (typeof file.base64 === 'string' && file.base64.length > 0) ||
      (typeof file.text === 'string' && file.text.length > 500) ||
      (Array.isArray(file.cells) && file.cells.length > 0)
    if (needsStrip) {
      next = sanitizeReadToolUseResult(next)
      changed = true
    }
  }

  if (typeof next.snapshot === 'string' && next.snapshot.length > 0) {
    delete next.snapshot
    changed = true
  }

  if (next.pageState && typeof next.pageState === 'object') {
    const ps = { ...next.pageState }
    if (typeof ps.artifactPath === 'string' && ps.artifactPath.length > 240) {
      ps.artifactPath = truncateString(ps.artifactPath, 240)
      next.pageState = ps
      changed = true
    }
  }

  if (browser && next.value !== undefined) {
    const v = sanitizeBrowserValue(next.value)
    if (v !== next.value) {
      next.value = v
      changed = true
    }
  }

  if (
    browser &&
    typeof next.message === 'string' &&
    next.message.length > MAX_BROWSER_MESSAGE_CHARS
  ) {
    next.message = truncateString(next.message, MAX_BROWSER_MESSAGE_CHARS)
    changed = true
  }

  if (browser && Array.isArray(next.consoleErrors) && next.consoleErrors.length > 8) {
    next.consoleErrors = next.consoleErrors.slice(0, 8)
    changed = true
  }
  if (browser && Array.isArray(next.network) && next.network.length > 12) {
    next.network = next.network.slice(0, 12)
    changed = true
  }

  if (browser) {
    try {
      const raw = JSON.stringify(next)
      if (raw && raw.length > MAX_TUR_JSON_CHARS) {
        return {
          truncated: true,
          preview: truncateString(raw, MAX_GENERIC_STRING),
          originalChars: raw.length,
        }
      }
    } catch {
      /* keep next */
    }
  }

  return changed ? next : tur
}

function payloadNeedsSanitize(name, data) {
  const resultStr = typeof data.result === 'string' ? data.result : ''
  const tur = data.toolUseResult
  if (isBrowserTool(name) || isReadTool(name)) return true
  if (
    resultStr.includes('Page snapshot') ||
    resultStr.includes('Current page snapshot')
  ) {
    return true
  }
  if (/data:image\/[a-zA-Z0-9+.-]+;base64,/.test(resultStr)) return true
  if (
    tur &&
    typeof tur === 'object' &&
    (tur.snapshot != null ||
      tur.file != null ||
      tur.pageState != null ||
      tur.type === 'image' ||
      tur.type === 'pdf' ||
      tur.type === 'parts')
  ) {
    return true
  }
  return false
}

/**
 * @param {string | undefined} name
 * @param {{ result?: unknown, toolUseResult?: unknown }} data
 */
export function sanitizeToolUpdatePayload(name, data) {
  if (!payloadNeedsSanitize(name, data)) return data

  return {
    ...data,
    result: sanitizeToolResultText(data.result),
    ...(data.toolUseResult !== undefined
      ? {
          toolUseResult: sanitizeToolUseResult(data.toolUseResult, {
            browser: isBrowserTool(name),
          }),
        }
      : {}),
  }
}

/**
 * @param {object[]} messages
 */
export function sanitizeMessagesForUi(messages) {
  if (!Array.isArray(messages)) return messages
  return messages.map(msg => {
    if (msg?.type === 'compact_boundary' && typeof msg.summary === 'string') {
      if (msg.summary.length > 4_000) {
        return {
          ...msg,
          summary: truncateString(msg.summary, 4_000),
          summaryLength: Math.min(msg.summaryLength ?? msg.summary.length, 4_000),
        }
      }
      return msg
    }
    if (msg?.type !== 'assistant' || !Array.isArray(msg.parts)) return msg
    let changed = false
    const parts = msg.parts.map(p => {
      if (p?.type !== 'tool_call') return p
      const next = sanitizeToolCallPart(p)
      if (next !== p) changed = true
      return next
    })
    return changed ? { ...msg, parts } : msg
  })
}

function sanitizeToolCallPart(p) {
  let next = p

  if (Array.isArray(p.subagentParts)) {
    let subChanged = false
    const sub = p.subagentParts.map(sp => {
      if (sp?.type !== 'tool_call') return sp
      const s2 = sanitizeToolCallPart(sp)
      if (s2 !== sp) subChanged = true
      return s2
    })
    if (subChanged) next = { ...next, subagentParts: sub }
  }

  const safe = sanitizeToolUpdatePayload(next.name, {
    result: next.result,
    toolUseResult: next.toolUseResult,
  })

  if (
    safe.result === next.result &&
    safe.toolUseResult === next.toolUseResult
  ) {
    return next
  }

  return {
    ...next,
    result: safe.result,
    ...(safe.toolUseResult !== undefined
      ? { toolUseResult: safe.toolUseResult }
      : {}),
  }
}
