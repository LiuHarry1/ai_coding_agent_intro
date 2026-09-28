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

const backendDownloadQueues = new WeakMap<BrowserBackend, Promise<void>>()

/**
 * chrome.downloads has no reliable tab/click identifier. Keep click→claim
 * atomic per browser so concurrent tool calls cannot steal each other's
 * download. chrome.downloads does not identify the initiating tab, so a
 * per-tab queue is not sufficient for same-origin tabs.
 */
async function withBackendDownloadLock<T>(
  backend: BrowserBackend,
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const previous = backendDownloadQueues.get(backend) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const tail = previous.catch(() => {}).then(() => gate)
  backendDownloadQueues.set(backend, tail)
  void tail.then(() => {
    if (backendDownloadQueues.get(backend) === tail) {
      backendDownloadQueues.delete(backend)
    }
  })
  let removeAbortListener = () => {}
  try {
    await new Promise<void>((resolve, reject) => {
      const aborted = () => {
        const reason = signal?.reason
        reject(
          reason instanceof Error
            ? reason
            : new BrowserError('Download wait was cancelled'),
        )
      }
      removeAbortListener = () => signal?.removeEventListener('abort', aborted)
      if (signal?.aborted) {
        aborted()
        return
      }
      signal?.addEventListener('abort', aborted, { once: true })
      previous.then(resolve, resolve)
    })
    removeAbortListener()
    throwIfDownloadAborted(signal)
    return await run()
  } finally {
    removeAbortListener()
    release()
  }
}

function normalizeTimeoutMs(
  timeoutMs: number | undefined,
  fallback: number,
): number {
  if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs)) {
    return Math.max(1, Math.floor(timeoutMs))
  }
  return fallback
}

function noDownloadMessage(timeoutMs: number, ref?: string): string {
  const after = ref ? ` after clicking ${ref}` : ''
  const duration =
    timeoutMs < 1_000
      ? `${Math.round(timeoutMs)}ms`
      : `${Number((timeoutMs / 1_000).toFixed(1))}s`
  return (
    `No download started within ${duration}${after}. ` +
    'The element may not trigger a download, or the site opens the file in a tab instead.\n' +
    'Recovery action: browser_snapshot, then browser_wait_for_download with the ref of the actual download link'
  )
}

function throwIfDownloadAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const reason = signal.reason
  throw reason instanceof Error
    ? reason
    : new BrowserError('Download wait was cancelled')
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
  opts: {
    path?: string
    ref?: string
    signal?: AbortSignal
    expectedUrl?: string
  },
): Promise<BrowserDownloadResult> {
  const found = await backend.waitForDownload!(targetId, {
    since,
    timeoutMs,
    signal: opts.signal,
    expectedUrl: opts.expectedUrl,
  })
  throwIfDownloadAborted(opts.signal)
  if (!found) throw new BrowserError(noDownloadMessage(timeoutMs, opts.ref))
  return saveBrowserDownload(
    {
      url: () => found.url,
      suggestedFilename: () =>
        path.basename(found.suggestedName || found.filename),
      saveAs: dest => copyFile(found.filename, dest),
    },
    {
      mode: 'explicit',
      outputPath: opts.path,
      outputRoot: DEFAULT_DOWNLOAD_DIR,
      signal: opts.signal,
    },
  )
}

export async function waitForDownload(
  backend: BrowserBackend,
  targetId: string,
  opts: { path?: string; timeoutMs?: number; signal?: AbortSignal } = {},
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
    signal: opts.signal,
    timeoutMessage: noDownloadMessage(timeout),
  })
  return await capture.promise
}

async function downloadByRefUnlocked(
  backend: BrowserBackend,
  targetId: string,
  opts: {
    ref: string
    path?: string
    timeoutMs?: number
    signal?: AbortSignal
  },
): Promise<BrowserDownloadResult> {
  const page = await getPageForTarget(backend, targetId)
  const timeout = normalizeTimeoutMs(opts.timeoutMs, DOWNLOAD_WAIT_MS)
  const ref = opts.ref.trim()
  if (!ref) throw new BrowserError('ref is required')

  const click = () =>
    withInputFocus(backend, targetId, async () => {
      throwIfDownloadAborted(opts.signal)
      await refLocator(page, ref).click({ timeout: ACTION_TIMEOUT_MS })
      throwIfDownloadAborted(opts.signal)
    })

  if (backend.waitForDownload) {
    throwIfDownloadAborted(opts.signal)
    const expectedUrl = await refLocator(page, ref)
      .evaluate(element => {
        const anchor =
          element instanceof HTMLAnchorElement
            ? element
            : element.closest('a[href]')
        return anchor instanceof HTMLAnchorElement ? anchor.href : undefined
      })
      .catch(() => undefined)
    const since = Date.now()
    try {
      await click()
    } catch (err) {
      mapPlaywrightError(err, ref)
    }
    return waitViaBackend(backend, targetId, since, timeout, {
      ...opts,
      ref,
      expectedUrl,
    })
  }

  const state = downloadStateForPage(page)
  const capture = createDownloadCaptureForPage(page, state, timeout, {
    mode: 'explicit',
    outputPath: opts.path,
    outputRoot: DEFAULT_DOWNLOAD_DIR,
    signal: opts.signal,
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

export async function downloadByRef(
  backend: BrowserBackend,
  targetId: string,
  opts: {
    ref: string
    path?: string
    timeoutMs?: number
    signal?: AbortSignal
  },
): Promise<BrowserDownloadResult> {
  return withBackendDownloadLock(backend, opts.signal, () =>
    downloadByRefUnlocked(backend, targetId, opts),
  )
}
