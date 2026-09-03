/**
 * Where browser_navigate may go. Localhost is allowed — this agent debugs
 * local apps. file: / javascript: / credentialed URLs are not.
 */

import { BrowserError } from './types.js'

const BLOCKED = new Set(['file:', 'javascript:', 'data:', 'vbscript:'])

export function assertNavigateUrl(raw: string): string {
  const src = (raw || '').trim()
  if (!src) throw new BrowserError('navigate requires a url')
  let parsed: URL
  try {
    parsed = new URL(src)
  } catch {
    throw new BrowserError(`Not a valid URL: ${JSON.stringify(src)}`)
  }
  const protocol = parsed.protocol.toLowerCase()
  if (BLOCKED.has(protocol)) {
    throw new BrowserError(
      `browser_navigate cannot open ${protocol} URLs. Use http(s).`,
    )
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new BrowserError(
      `browser_navigate only allows http(s), not ${protocol}`,
    )
  }
  if (parsed.username || parsed.password) {
    throw new BrowserError(
      'browser_navigate cannot include credentials in the URL.',
    )
  }
  rejectConcurReportNumber(parsed)
  return parsed.href
}

/**
 * Concur's list shows a short report number (e.g. WPIXXZ). The real id in
 * `/nui/expense/reports/<id>` is a long hex GUID. Navigating to the number
 * opens an error dialog and dumps the agent back to the report list.
 */
function rejectConcurReportNumber(parsed: URL): void {
  if (!/(^|\.)concursolutions\.com$/i.test(parsed.hostname)) return
  const m = parsed.pathname.match(
    /\/(?:nui\/expense\/)?reports?\/([^/]+)(?:\/|$)/i,
  )
  if (!m) return
  const id = decodeURIComponent(m[1] ?? '')
  const hex = id.replace(/-/g, '')
  if (/^[0-9a-f]{16,}$/i.test(hex)) return
  throw new BrowserError(
    `This URL uses report number ${JSON.stringify(id)}, not the report GUID. Click the report in the current list. Copy the GUID already in the address bar — do not put the short code into /reports/.`,
  )
}
