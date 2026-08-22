/** Wait for a download, or click a ref then wait. */
import type { BrowserBackend } from '../types.js'
import { BrowserError } from '../types.js'
import { ACTION_TIMEOUT_MS } from '../limits.js'
import { getPageForTarget } from './connect.js'
import { mapPlaywrightError, refLocator } from './locator.js'
import { withInputFocus } from './focus.js'
import {
  createDownloadCaptureForPage,
  DEFAULT_DOWNLOAD_DIR,
  downloadStateForPage,
} from './download-capture.js'
import type { BrowserDownloadResult } from '../download-types.js'

function normalizeTimeoutMs(timeoutMs: number | undefined, fallback: number): number {
  if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs)) {
    return Math.max(1, Math.floor(timeoutMs))
  }
  return fallback
}

export async function waitForDownload(
  backend: BrowserBackend,
  targetId: string,
  opts: { path?: string; timeoutMs?: number } = {},
): Promise<BrowserDownloadResult> {
  const page = await getPageForTarget(backend, targetId)
  const state = downloadStateForPage(page)
  const timeout = normalizeTimeoutMs(opts.timeoutMs, 120_000)
  const capture = createDownloadCaptureForPage(page, state, timeout, {
    mode: 'explicit',
    outputPath: opts.path,
    outputRoot: DEFAULT_DOWNLOAD_DIR,
  })
  return await capture.promise
}

export async function downloadByRef(
  backend: BrowserBackend,
  targetId: string,
  opts: { ref: string; path?: string; timeoutMs?: number },
): Promise<BrowserDownloadResult> {
  const page = await getPageForTarget(backend, targetId)
  const state = downloadStateForPage(page)
  const timeout = normalizeTimeoutMs(opts.timeoutMs, 120_000)
  const ref = opts.ref.trim()
  if (!ref) throw new BrowserError('ref is required')

  const capture = createDownloadCaptureForPage(page, state, timeout, {
    mode: 'explicit',
    outputPath: opts.path,
    outputRoot: DEFAULT_DOWNLOAD_DIR,
  })
  void capture.promise.catch(() => {})
  try {
    await withInputFocus(backend, targetId, async () => {
      await refLocator(page, ref).click({ timeout: timeout || ACTION_TIMEOUT_MS })
    })
  } catch (err) {
    capture.cancel()
    mapPlaywrightError(err, ref)
  }
  return await capture.promise
}
