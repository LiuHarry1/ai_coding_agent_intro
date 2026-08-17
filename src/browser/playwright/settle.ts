/**
 * Letting the page catch up after an action, so the snapshot that follows shows
 * the result rather than the state just before it.
 */

import type { Page, Request } from 'playwright-core'
import { ACTION_SETTLE_MS, NETWORK_DRAIN_MS } from '../limits.js'

function isTrackedRequest(req: Request): boolean {
  const type = req.resourceType()
  return type === 'xhr' || type === 'fetch'
}

/**
 * Playwright MCP's waitForNetwork: listen for XHR/fetch started by the action,
 * wait a short settle, then drain those requests. Deliberately does not wait
 * for an ARIA dialog to look "rich" — that heuristic stalls on pages that keep
 * polling.
 */
export async function withActionWait<T>(
  page: Page,
  action: () => Promise<T>,
): Promise<T> {
  const pending = new Set<Request>()
  const onRequest = (req: Request) => {
    if (isTrackedRequest(req)) pending.add(req)
  }
  const onDone = (req: Request) => {
    pending.delete(req)
  }
  page.on('request', onRequest)
  page.on('requestfinished', onDone)
  page.on('requestfailed', onDone)
  try {
    const result = await action()
    await new Promise<void>(r => setTimeout(r, ACTION_SETTLE_MS))
    const deadline = Date.now() + NETWORK_DRAIN_MS
    while (pending.size > 0 && Date.now() < deadline) {
      await new Promise<void>(r => setTimeout(r, 50))
    }
    return result
  } finally {
    page.off('request', onRequest)
    page.off('requestfinished', onDone)
    page.off('requestfailed', onDone)
  }
}
