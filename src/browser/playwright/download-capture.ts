/** Arm a page download listener and save the file under the output root. */
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { Page } from 'playwright-core'
import type {
  BrowserDownloadCandidate,
  BrowserDownloadResult,
} from '../download-types.js'
import { writeExternalFileWithinOutputRoot } from '../output-files.js'
import { DEFAULT_DOWNLOAD_DIR } from '../paths.js'
import { sanitizeUntrustedFileName } from '../safe-filename.js'

export { DEFAULT_DOWNLOAD_DIR }
export { sanitizeUntrustedFileName }

type BrowserDownloadCaptureState = {
  downloadWaiterDepth: number
  waiters: Array<{ dispatch: (download: unknown) => void }>
  handler?: (download: unknown) => void
}

export type BrowserDownloadCaptureOptions = {
  beforeSave?: (download: BrowserDownloadCandidate) => Promise<void> | void
  mode?: 'passive' | 'explicit'
  outputPath?: string
  outputRoot?: string
  signal?: AbortSignal
  timeoutMessage?: string
}

export type PlaywrightDownload = {
  url?: () => string
  suggestedFilename?: () => string
  saveAs?: (outPath: string) => Promise<void>
}

function buildManagedDownloadPath(rootDir: string, fileName: string): string {
  const id = randomUUID()
  const safeName = sanitizeUntrustedFileName(fileName, 'download.bin')
  return path.join(rootDir, `${id}-${safeName}`)
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const reason = signal.reason
  throw reason instanceof Error
    ? reason
    : new Error('Download save was cancelled')
}

export async function saveBrowserDownload(
  download: PlaywrightDownload,
  opts: BrowserDownloadCaptureOptions = {},
): Promise<BrowserDownloadResult> {
  throwIfAborted(opts.signal)
  const suggestedFilename = download.suggestedFilename?.() || 'download.bin'
  const candidate: BrowserDownloadCandidate = {
    url: download.url?.() || '',
    suggestedFilename,
  }
  await opts.beforeSave?.(candidate)
  throwIfAborted(opts.signal)
  const saveAs = download.saveAs?.bind(download)
  if (!saveAs) {
    throw new Error('Download cannot be saved')
  }
  const requestedPath = opts.outputPath?.trim()
  const implicitRoot = opts.outputRoot ?? DEFAULT_DOWNLOAD_DIR
  const managedPath =
    requestedPath || buildManagedDownloadPath(implicitRoot, suggestedFilename)
  const savedPath = await writeExternalFileWithinOutputRoot({
    rootDir: requestedPath ? opts.outputRoot : implicitRoot,
    path: managedPath,
    write: async tempPath => {
      throwIfAborted(opts.signal)
      await saveAs(tempPath)
      // Playwright's saveAs is not itself abortable. Checking before the
      // sibling-temp file is committed prevents a cancelled save from being
      // published even when cancellation arrives while bytes are being copied.
      throwIfAborted(opts.signal)
    },
  })
  return { ...candidate, path: savedPath }
}

export function createDownloadCaptureForPage(
  page: Page,
  state: BrowserDownloadCaptureState,
  timeoutMs: number,
  opts: BrowserDownloadCaptureOptions = {},
): {
  armed: boolean
  promise: Promise<BrowserDownloadResult>
  cancel: () => void
} {
  if (opts.mode !== 'explicit' && state.downloadWaiterDepth > 0) {
    return {
      armed: false,
      promise: new Promise<BrowserDownloadResult>(() => {}),
      cancel: () => {},
    }
  }

  state.downloadWaiterDepth += 1
  let done = false
  let depthReleased = false
  let timer: NodeJS.Timeout | undefined
  let abort = () => {}
  let waiter: { dispatch: (download: unknown) => void } | undefined

  const cleanup = () => {
    if (!depthReleased) {
      depthReleased = true
      state.downloadWaiterDepth = Math.max(0, state.downloadWaiterDepth - 1)
    }
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    if (waiter) {
      const index = state.waiters.indexOf(waiter)
      if (index >= 0) state.waiters.splice(index, 1)
      waiter = undefined
    }
    if (state.waiters.length === 0 && state.handler) {
      page.off('download', state.handler as never)
      state.handler = undefined
    }
    opts.signal?.removeEventListener('abort', abort)
  }

  const promise = new Promise<BrowserDownloadResult>((resolve, reject) => {
    waiter = {
      dispatch: (download: unknown) => {
        if (done) return
        done = true
        cleanup()
        void saveBrowserDownload(download as PlaywrightDownload, opts).then(
          resolve,
          reject,
        )
      },
    }
    state.waiters.push(waiter)
    if (!state.handler) {
      state.handler = (download: unknown) => {
        // One browser download belongs to exactly one explicit waiter. Using a
        // listener per waiter makes every concurrent call consume the first
        // event and loses later downloads.
        state.waiters[0]?.dispatch(download)
      }
      page.on('download', state.handler as never)
    }
    timer = setTimeout(() => {
      if (done) {
        return
      }
      done = true
      cleanup()
      reject(new Error(opts.timeoutMessage ?? 'Timeout waiting for download'))
    }, Math.max(1, timeoutMs))
    timer.unref?.()
    abort = () => {
      if (done) {
        return
      }
      done = true
      cleanup()
      const reason = opts.signal?.reason
      reject(
        reason instanceof Error
          ? reason
          : new Error('Download wait was cancelled'),
      )
    }
    opts.signal?.addEventListener('abort', abort, { once: true })
    if (opts.signal?.aborted) {
      abort()
    }
  })

  return {
    armed: true,
    promise,
    cancel: () => {
      if (done) {
        return
      }
      done = true
      cleanup()
    },
  }
}

const pageDownloadState = new WeakMap<Page, BrowserDownloadCaptureState>()

export function downloadStateForPage(page: Page): BrowserDownloadCaptureState {
  let state = pageDownloadState.get(page)
  if (!state) {
    state = { downloadWaiterDepth: 0, waiters: [] }
    pageDownloadState.set(page, state)
  }
  return state
}
