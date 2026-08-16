/**
 * Resolve a Playwright Page for a tool-layer targetId.
 *
 * Isolated: the backend already owns Page objects from launchPersistentContext.
 * Extension: connectOverCDP to the synthetic browser endpoint (OpenClaw's
 * pattern) so the same ariaSnapshot / aria-ref locators work against the
 * user's signed-in Chrome.
 */

import type { Browser, Page } from 'playwright-core'
import { chromium } from 'playwright-core'
import { getIsolatedPage } from '../backends/isolated.js'
import { BrowserError, type BrowserBackend } from '../types.js'
import {
  startCdpEndpoint,
  type CdpEndpoint,
} from './cdp-endpoint.js'
import type { RelayServer } from '../relay/server.js'

const browsers = new WeakMap<BrowserBackend, Promise<Browser>>()
const endpoints = new WeakMap<BrowserBackend, CdpEndpoint>()

const PAGE_ATTACH_MS = 3_000

export async function attachExtensionPlaywright(
  backend: BrowserBackend,
  relay: RelayServer,
): Promise<void> {
  if (backend.kind !== 'extension') return
  if (endpoints.has(backend)) return
  const endpoint = await startCdpEndpoint({ backend, relay })
  endpoints.set(backend, endpoint)
}

export async function detachPlaywright(backend: BrowserBackend): Promise<void> {
  const browserP = browsers.get(backend)
  browsers.delete(backend)
  if (browserP) {
    const browser = await browserP.catch(() => null)
    await browser?.close().catch(() => {})
  }
  const endpoint = endpoints.get(backend)
  endpoints.delete(backend)
  await endpoint?.close().catch(() => {})
}

async function connectExtension(backend: BrowserBackend): Promise<Browser> {
  const existing = browsers.get(backend)
  if (existing) {
    const browser = await existing
    if (browser.isConnected()) return browser
    browsers.delete(backend)
  }

  const endpoint = endpoints.get(backend)
  if (!endpoint) {
    throw new BrowserError(
      'Playwright engine is not attached to the extension backend. ' +
        'Set browser.engine to "playwright" and restart the agent.',
    )
  }

  const connecting = chromium.connectOverCDP(endpoint.httpUrl, {
    timeout: 20_000,
  })
  browsers.set(backend, connecting)
  try {
    return await connecting
  } catch (err) {
    browsers.delete(backend)
    const message = err instanceof Error ? err.message : String(err)
    throw new BrowserError(
      `Playwright could not connectOverCDP to the extension relay: ${message}`,
    )
  }
}

function allPages(browser: Browser): Page[] {
  return browser.contexts().flatMap(ctx => ctx.pages().filter(p => !p.isClosed()))
}

export function isBlankUrl(url: string): boolean {
  return !url || url === 'about:blank' || url.startsWith('chrome://newtab')
}

/** Same origin+path, ignoring hash and query (tracking params churn on SPAs). */
export function urlsRoughlyEqual(a: string, b: string): boolean {
  if (a === b) return true
  try {
    const left = new URL(a)
    const right = new URL(b)
    if (left.origin !== right.origin) return false
    const pathA = left.pathname.replace(/\/+$/, '') || '/'
    const pathB = right.pathname.replace(/\/+$/, '') || '/'
    return pathA === pathB
  } catch {
    return false
  }
}

export function pickPageForTab<T extends { url(): string }>(
  pages: T[],
  tabUrl: string,
): T | undefined {
  const live = pages.filter(p => {
    try {
      p.url()
      return true
    } catch {
      return false
    }
  })
  const exact = live.filter(p => urlsRoughlyEqual(p.url(), tabUrl))
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) return exact[exact.length - 1]
  if (isBlankUrl(tabUrl)) {
    const blanks = live.filter(p => isBlankUrl(p.url()))
    if (blanks.length === 1) return blanks[0]
    if (blanks.length > 1) return blanks[blanks.length - 1]
  }
  return undefined
}

async function findPage(
  backend: BrowserBackend,
  browser: Browser,
  targetId: string,
): Promise<Page> {
  const tabs = await backend.listTabs()
  const tab = tabs.find(t => t.targetId === targetId)
  if (!tab) {
    throw new BrowserError(
      `No open tab with id "${targetId}". Use browser_tabs with action "new" to open one, or share a tab from the extension popup.`,
    )
  }

  const pages = allPages(browser)
  const matched = pickPageForTab(pages, tab.url)
  if (matched) return matched

  if (pages.length === 0) {
    throw new BrowserError(
      'Playwright connected but sees no pages. Share a tab from the extension popup, or open one with browser_tabs action "new".',
    )
  }

  throw new BrowserError(
    `Could not match tab "${targetId}" (${tab.url}) to a Playwright page. Open a tab with browser_tabs action "new" (do not select an unshared id), or share it from the extension popup.`,
  )
}

export async function getPageForTarget(
  backend: BrowserBackend,
  targetId: string,
): Promise<Page> {
  if (backend.kind === 'isolated') {
    const page = getIsolatedPage(backend, targetId)
    if (!page || page.isClosed()) {
      throw new BrowserError(
        `Unknown tab "${targetId}". It was closed or belongs to another browser session; list tabs again.`,
      )
    }
    return page
  }

  const browser = await connectExtension(backend)
  const endpoint = endpoints.get(backend)
  await endpoint?.syncTabs()

  const deadline = Date.now() + PAGE_ATTACH_MS
  let lastErr: Error | undefined
  while (Date.now() <= deadline) {
    try {
      return await findPage(backend, browser, targetId)
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err))
      await new Promise(r => setTimeout(r, 120))
      await endpoint?.syncTabs()
    }
  }
  throw lastErr ?? new BrowserError('Playwright could not attach to the tab.')
}
