/** Wait for a download, or click a ref then wait. */
import { copyFile } from 'node:fs/promises'
import path from 'node:path'
import type { BrowserBackend } from '../types.js'
import { BrowserError } from '../types.js'
import { ACTION_TIMEOUT_MS, DOWNLOAD_WAIT_MS } from '../limits.js'
import { getPageForTarget } from './connect.js'
import { mapPlaywrightError, refLocator } from './locator.js'
import { withInputFocus } from './focus.js'
import {
  createDownloadCaptureForPage,
  DEFAULT_DOWNLOAD_DIR,
  downloadStateForPage,
  saveBrowserDownload,
} from './download-capture.js'
import type { BrowserDownloadResult } from '../download-types.js'

function normalizeTimeoutMs(timeoutMs: number | undefined, fallback: number): number {
  if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs)) {
    return Math.max(1, Math.floor(timeoutMs))
  }
  return fallback
}

function noDownloadMessage(timeoutMs: number, ref?: string): string {
  const after = ref ? ` after clicking ${ref}` : ''
  return (
    `No download started within ${Math.round(timeoutMs / 1000)}s${after}. ` +
    'The element may not trigger a download, or the site opens the file in a tab instead.\n' +
    'Recovery action: browser_snapshot, then browser_wait_for_download with the ref of the actual download link'
  )
}

/**
 * Copy a file the browser already saved into the agent's download folder, so
 * both backends hand back a path under the same root.
 */
async function waitViaBackend(
  backend: BrowserBackend,
  targetId: string,
  since: number,
  timeoutMs: number,
  opts: { path?: string; ref?: string },
): Promise<BrowserDownloadResult> {
  const found = await backend.waitForDownload!(targetId, { since, timeoutMs })
  if (!found) throw new BrowserError(noDownloadMessage(timeoutMs, opts.ref))
  return saveBrowserDownload(
    {
      url: () => found.url,
      suggestedFilename: () =>
        path.basename(found.suggestedName || found.filename),
      saveAs: dest => copyFile(found.filename, dest),
    },
    { mode: 'explicit', outputPath: opts.path, outputRoot: DEFAULT_DOWNLOAD_DIR },
  )
}

export async function waitForDownload(
  backend: BrowserBackend,
  targetId: string,
  opts: { path?: string; timeoutMs?: number } = {},
): Promise<BrowserDownloadResult> {
  const timeout = normalizeTimeoutMs(opts.timeoutMs, DOWNLOAD_WAIT_MS)
  if (backend.waitForDownload) {
    return waitViaBackend(backend, targetId, Date.now(), timeout, opts)
  }
  const page = await getPageForTarget(backend, targetId)
  const state = downloadStateForPage(page)
  const capture = createDownloadCaptureForPage(page, state, timeout, {
    mode: 'explicit',
    outputPath: opts.path,
    outputRoot: DEFAULT_DOWNLOAD_DIR,
    timeoutMessage: noDownloadMessage(timeout),
  })
  return await capture.promise
}

export async function downloadByRef(
  backend: BrowserBackend,
  targetId: string,
  opts: { ref: string; path?: string; timeoutMs?: number },
): Promise<BrowserDownloadResult> {
  const page = await getPageForTarget(backend, targetId)
  const timeout = normalizeTimeoutMs(opts.timeoutMs, DOWNLOAD_WAIT_MS)
  const ref = opts.ref.trim()
  if (!ref) throw new BrowserError('ref is required')

  const click = () =>
    withInputFocus(backend, targetId, async () => {
      await refLocator(page, ref).click({ timeout: ACTION_TIMEOUT_MS })
    })

  if (backend.waitForDownload) {
    const since = Date.now()
    try {
      await click()
    } catch (err) {
      mapPlaywrightError(err, ref)
    }
    return waitViaBackend(backend, targetId, since, timeout, { ...opts, ref })
  }

  const state = downloadStateForPage(page)
  const capture = createDownloadCaptureForPage(page, state, timeout, {
    mode: 'explicit',
    outputPath: opts.path,
    outputRoot: DEFAULT_DOWNLOAD_DIR,
    timeoutMessage: noDownloadMessage(timeout, ref),
  })
  void capture.promise.catch(() => {})
  try {
    await click()
  } catch (err) {
    capture.cancel()
    mapPlaywrightError(err, ref)
  }
  return await capture.promise
}
