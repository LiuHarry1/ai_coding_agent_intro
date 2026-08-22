/**
 * Phase-1 backend: a Chrome instance we launch and own.
 *
 * We use `playwright-core` purely as a CDP transport + process babysitter —
 * `channel: 'chrome'` reuses the system Chrome so there is no browser download,
 * and a dedicated `userDataDir` keeps the agent out of the user's real profile.
 * Because we launch the process ourselves, `--remote-debugging-*` is our own
 * flag and Chrome 144's "Allow remote debugging?" modal never appears.
 *
 * Launching Chrome lives here. The Playwright layer in `src/browser/playwright/`
 * reuses the Page objects this backend already owns.
 */

import type { BrowserContext, CDPSession, Page } from 'playwright-core'
import { chromium } from 'playwright-core'
import { BrowserError, type BrowserBackend, type BrowserTab } from '../types.js'

const pagesByBackend = new WeakMap<BrowserBackend, Map<string, TabEntry>>()

/** The Playwright Page for a tab this backend launched, if it is still open. */
export function getIsolatedPage(
  backend: BrowserBackend,
  targetId: string,
): Page | undefined {
  return pagesByBackend.get(backend)?.get(targetId)?.page
}

export interface IsolatedBackendOptions {
  userDataDir: string
  headless?: boolean
  channel?: string
  viewport?: { width: number; height: number }
}

interface TabEntry {
  page: Page
  session: CDPSession
}

export async function createIsolatedBackend(
  opts: IsolatedBackendOptions,
): Promise<BrowserBackend> {
  const viewport = opts.viewport ?? { width: 1280, height: 800 }

  let context: BrowserContext
  try {
    context = await chromium.launchPersistentContext(opts.userDataDir, {
      channel: opts.channel ?? 'chrome',
      headless: opts.headless ?? false,
      viewport,
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-search-engine-choice-screen',
        // Chrome's "restore pages?" bubble after an unclean agent shutdown
        // would otherwise sit on top of every screenshot.
        '--hide-crash-restore-bubble',
      ],
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new BrowserError(
      `Failed to launch Chrome (channel "${opts.channel ?? 'chrome'}"): ${message}. ` +
        'Install Google Chrome, or set browser.channel in settings (e.g. "chromium", "msedge").',
    )
  }

  const tabs = new Map<string, TabEntry>()

  async function adopt(page: Page): Promise<string> {
    for (const [id, entry] of tabs) {
      if (entry.page === page) return id
    }
    const session = await context.newCDPSession(page)
    const { targetInfo } = await session.send('Target.getTargetInfo')
    const targetId = targetInfo.targetId
    tabs.set(targetId, { page, session })
    page.once('close', () => tabs.delete(targetId))
    return targetId
  }

  function entryOf(targetId: string): TabEntry {
    const entry = tabs.get(targetId)
    if (!entry) {
      throw new BrowserError(
        `Unknown tab "${targetId}". It was closed or belongs to another browser session; list tabs again.`,
      )
    }
    return entry
  }

  async function describe(targetId: string, page: Page): Promise<BrowserTab> {
    let title = ''
    try {
      title = await page.title()
    } catch {
      // A page mid-navigation can reject title(); url alone still identifies it.
    }
    return { targetId, url: page.url(), title }
  }

  const backend: BrowserBackend = {
    kind: 'isolated',

    async listTabs() {
      const out: BrowserTab[] = []
      for (const page of context.pages()) {
        if (page.isClosed()) continue
        const targetId = await adopt(page)
        out.push(await describe(targetId, page))
      }
      return out
    },

    async createTab(url) {
      // A freshly launched persistent context already owns one blank page;
      // reuse it so the first navigate doesn't leave an orphan tab behind.
      const blank = context
        .pages()
        .find(
          p => !p.isClosed() && (p.url() === 'about:blank' || p.url() === ''),
        )
      const page = blank ?? (await context.newPage())
      const targetId = await adopt(page)
      if (url) {
        await page.goto(url, { waitUntil: 'domcontentloaded' })
      }
      return describe(targetId, page)
    },

    async closeTab(targetId) {
      const { page } = entryOf(targetId)
      tabs.delete(targetId)
      await page.close()
    },

    async send(targetId, method, params) {
      const { session } = entryOf(targetId)
      return session.send(method as never, params as never) as never
    },

    async getActiveUserTabId() {
      return null
    },

    async focusTab(targetId) {
      const { page } = entryOf(targetId)
      await page.bringToFront().catch(() => {})
    },

    async restoreTab() {
      // Isolated Chrome is a dedicated window; nothing to restore.
    },

    async dispose() {
      tabs.clear()
      pagesByBackend.delete(backend)
      await context.close().catch(() => {})
    },
  }

  pagesByBackend.set(backend, tabs)
  return backend
}
