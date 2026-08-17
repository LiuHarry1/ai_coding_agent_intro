/**
 * How the model sees the page: Playwright's own AI aria snapshot, with `eN`
 * refs stamped on the live DOM, then spent against a budget by priority.
 *
 * Same mechanism OpenClaw and Playwright MCP use, so a ref here means what it
 * means there.
 */

import type { Page } from 'playwright-core'
import {
  COMPACT_DEPTH,
  DEFAULT_MAX_CHARS,
  SNAPSHOT_TIMEOUT_MS,
  WAIT_FOR_TIMEOUT_MS,
  WAIT_FOR_TIME_CAP_S,
} from '../limits.js'
import {
  BrowserError,
  type BrowserBackend,
  type SnapshotOpts,
  type SnapshotResult,
} from '../types.js'
import { mapPlaywrightError } from './locator.js'
import { countRefs, prioritizeAriaSnapshot } from '../distill-snapshot.js'
import { getPageForTarget } from './connect.js'

/**
 * A selector can match several nodes — a framework often renders the same panel
 * shell repeatedly and leaves one populated. The one with the most refs is the
 * one the model asked about.
 */
async function richestLocatorSnapshot(
  page: Page,
  selector: string,
  timeout: number,
): Promise<string> {
  const loc = page.locator(selector)
  const n = await loc.count().catch(() => 0)
  if (n <= 1) {
    return loc.ariaSnapshot({ mode: 'ai', timeout })
  }
  let best = ''
  let bestRefs = -1
  for (let i = 0; i < n; i++) {
    const yaml = await loc
      .nth(i)
      .ariaSnapshot({ mode: 'ai', timeout })
      .catch(() => '')
    const refs = countRefs(yaml)
    if (refs > bestRefs) {
      bestRefs = refs
      best = yaml
    }
  }
  return best
}

export async function snapshot(
  backend: BrowserBackend,
  targetId: string,
  opts: SnapshotOpts = {},
): Promise<SnapshotResult> {
  const page = await getPageForTarget(backend, targetId)
  try {
    // compact on a subtree must not clip depth: that is what turned an open
    // dialog into Close + title. A selector-scoped snapshot is already narrow.
    const depth = opts.compact && !opts.selector ? COMPACT_DEPTH : undefined
    const raw = opts.selector
      ? await richestLocatorSnapshot(page, opts.selector, SNAPSHOT_TIMEOUT_MS)
      : await page.ariaSnapshot({
          mode: 'ai',
          timeout: SNAPSHOT_TIMEOUT_MS,
          ...(depth !== undefined ? { depth } : {}),
        })
    const { text, truncated } = prioritizeAriaSnapshot(raw, {
      maxChars: opts.maxChars ?? DEFAULT_MAX_CHARS,
      maxNodes: opts.maxNodes,
    })
    return {
      url: page.url(),
      title: await page.title().catch(() => ''),
      text,
      nodes: countRefs(text),
      truncated,
    }
  } catch (err) {
    mapPlaywrightError(err)
  }
}

export async function waitFor(
  backend: BrowserBackend,
  targetId: string,
  opts: { time?: number; text?: string; textGone?: string },
): Promise<void> {
  if (!opts.text && !opts.textGone && opts.time == null) {
    throw new BrowserError('Either time, text or textGone must be provided')
  }
  const page = await getPageForTarget(backend, targetId)
  try {
    if (opts.time != null) {
      const ms = Math.min(WAIT_FOR_TIME_CAP_S, Math.max(0, opts.time)) * 1000
      await new Promise<void>(r => setTimeout(r, ms))
    }
    if (opts.textGone) {
      await page
        .getByText(opts.textGone)
        .first()
        .waitFor({ state: 'hidden', timeout: WAIT_FOR_TIMEOUT_MS })
    }
    if (opts.text) {
      await page
        .getByText(opts.text)
        .first()
        .waitFor({ state: 'visible', timeout: WAIT_FOR_TIMEOUT_MS })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const what = opts.text
      ? `text ${JSON.stringify(opts.text)} to appear`
      : opts.textGone
        ? `text ${JSON.stringify(opts.textGone)} to disappear`
        : 'condition'
    throw new BrowserError(
      /Timeout/i.test(message) ? `Timed out waiting for ${what}.` : message,
    )
  }
}
