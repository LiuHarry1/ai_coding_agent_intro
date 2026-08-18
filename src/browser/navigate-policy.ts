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
  return parsed.href
}
