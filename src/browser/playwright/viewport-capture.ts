/**
 * Viewport capture that works over the extension relay.
 *
 * Playwright's page.screenshot sends Page.captureScreenshot with a `clip`,
 * which over chrome.debugger can wait 20s+ for a frame. Extension mode
 * captures the viewport directly; isolated Chrome keeps Playwright's path.
 * Over the relay a capture can still wait on a frame Chrome never schedules;
 * a second capture request produces it and unblocks the first, so a stalled
 * capture is re-requested every CAPTURE_KICK_MS until one returns.
 */
import type { Page } from 'playwright-core'
import type { BrowserBackend } from '../types.js'
import { SCREENSHOT_TIMEOUT_MS } from '../limits.js'

const CAPTURE_KICK_MS = 1_500

export async function captureViewport(
  backend: BrowserBackend,
  targetId: string,
  page: Page,
  opts: { type: 'png' | 'jpeg'; quality?: number; timeoutMs?: number },
): Promise<Buffer> {
  const timeoutMs = opts.timeoutMs ?? SCREENSHOT_TIMEOUT_MS
  if (backend.kind !== 'extension') {
    return Buffer.from(
      await page.screenshot({
        type: opts.type,
        timeout: timeoutMs,
        ...(opts.type === 'jpeg' && opts.quality !== undefined
          ? { quality: opts.quality }
          : {}),
      }),
    )
  }
  const params = {
    format: opts.type,
    ...(opts.type === 'jpeg' ? { quality: opts.quality ?? 80 } : {}),
  }
  const timers: NodeJS.Timeout[] = []
  try {
    const data = await new Promise<string>((resolve, reject) => {
      let failures = 0
      let requests = 0
      const request = () => {
        requests += 1
        backend
          .send<{ data: string }>(targetId, 'Page.captureScreenshot', params)
          .then(
            result => resolve(result.data),
            err => {
              failures += 1
              if (failures === requests) reject(err)
            },
          )
      }
      request()
      timers.push(setInterval(request, CAPTURE_KICK_MS))
      timers.push(
        setTimeout(
          () =>
            reject(
              new Error(`Page.captureScreenshot: Timeout ${timeoutMs}ms exceeded.`),
            ),
          timeoutMs,
        ),
      )
    })
    return Buffer.from(data, 'base64')
  } finally {
    for (const timer of timers) clearTimeout(timer)
  }
}
