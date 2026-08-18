/**
 * Getting a Playwright Page for a tool-layer targetId, and owning the
 * connection that makes one available.
 *
 * Isolated: the backend already holds Page objects from launchPersistentContext,
 * so there is nothing to connect.
 * Extension: connectOverCDP against the synthetic browser endpoint the relay
 * exposes (OpenClaw's pattern), so the same ariaSnapshot and aria-ref locators
 * work against the user's signed-in Chrome.
 */

import type { Browser, Page } from 'playwright-core'
import { chromium } from 'playwright-core'
import { getIsolatedPage } from '../backends/isolated.js'
import { startCdpEndpoint, type CdpEndpoint } from '../relay/cdp-endpoint.js'
import type { RelayServer } from '../relay/server.js'
import { BrowserError, type BrowserBackend } from '../types.js'
import { pickPageForTab } from './page-match.js'
import { watchPage } from './overlays.js'

const browsers = new WeakMap<BrowserBackend, Promise<Browser>>()
const endpoints = new WeakMap<BrowserBackend, CdpEndpoint>()

const PAGE_ATTACH_MS = 3_000
const pagesByTarget = new Map<string, Page>()

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
  pagesByTarget.clear()
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
      'Playwright is not attached to the extension backend. Restart the agent.',
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
  // Cached Page for this targetId is the identity. An SPA can change path
  // without a new Page; URL matching below is only the cold-cache fallback.
  const cached = pagesByTarget.get(targetId)
  if (cached && !cached.isClosed() && pages.includes(cached)) {
    pagesByTarget.set(targetId, cached)
    return cached
  }
  const matched = pickPageForTab(pages, tab.url)
  if (matched) {
    pagesByTarget.set(targetId, matched)
    return matched
  }

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
    return watchPage(page)
  }

  const browser = await connectExtension(backend)
  const endpoint = endpoints.get(backend)
  await endpoint?.syncTabs()

  // The relay learns about a shared tab asynchronously, so a page the model just
  // asked for may not be attached yet. Re-sync and retry rather than fail.
  const deadline = Date.now() + PAGE_ATTACH_MS
  let lastErr: Error | undefined
  while (Date.now() <= deadline) {
    try {
      return watchPage(await findPage(backend, browser, targetId))
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err))
      await new Promise(r => setTimeout(r, 120))
      await endpoint?.syncTabs()
    }
  }
  throw lastErr ?? new BrowserError('Playwright could not attach to the tab.')
}
