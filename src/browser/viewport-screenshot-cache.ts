import type { BrowserBackend } from './types.js'

export interface FreshViewportScreenshot {
  url: string
  viewportCssWidth: number
  viewportCssHeight: number
  sentImageWidth: number
  sentImageHeight: number
}

const cache = new WeakMap<
  BrowserBackend,
  Map<string, FreshViewportScreenshot>
>()

function backendCache(
  backend: BrowserBackend,
): Map<string, FreshViewportScreenshot> {
  let entries = cache.get(backend)
  if (!entries) {
    entries = new Map()
    cache.set(backend, entries)
  }
  return entries
}

export function rememberViewportScreenshot(
  backend: BrowserBackend,
  targetId: string,
  screenshot: FreshViewportScreenshot,
): void {
  backendCache(backend).set(targetId, screenshot)
}

export function getViewportScreenshot(
  backend: BrowserBackend,
  targetId: string,
): FreshViewportScreenshot | undefined {
  return cache.get(backend)?.get(targetId)
}

export function clearViewportScreenshot(
  backend: BrowserBackend,
  targetId: string,
): void {
  cache.get(backend)?.delete(targetId)
}
