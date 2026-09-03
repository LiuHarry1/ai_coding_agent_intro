/**
 * Bounded visible page prose for the model — OpenClaw `action=text` equivalent.
 * Prefer this over a full accessibility snapshot when the goal is reading copy.
 */

import {
  DEFAULT_MAX_CHARS,
  SNAPSHOT_TIMEOUT_MS,
} from '../limits.js'
import type { BrowserBackend } from '../types.js'
import {
  ariaRefCssSelectorMessage,
  isAriaRefCssSelector,
} from '../selector-guard.js'
import { getPageForTarget } from './connect.js'

const DEFAULT_SELECTORS = ['article', 'main', 'body'] as const

export async function getPageText(
  backend: BrowserBackend,
  targetId: string,
  opts: { selector?: string; maxChars?: number } = {},
): Promise<{
  url: string
  title: string
  text: string
  truncated: boolean
  selectorUsed: string
}> {
  const page = await getPageForTarget(backend, targetId)
  const maxChars =
    typeof opts.maxChars === 'number' && opts.maxChars > 0
      ? Math.min(Math.floor(opts.maxChars), DEFAULT_MAX_CHARS)
      : DEFAULT_MAX_CHARS

  if (opts.selector && isAriaRefCssSelector(opts.selector)) {
    return {
      url: page.url(),
      title: await page.title().catch(() => ''),
      text: ariaRefCssSelectorMessage(opts.selector),
      truncated: false,
      selectorUsed: opts.selector,
    }
  }

  const candidates = opts.selector
    ? [opts.selector]
    : [...DEFAULT_SELECTORS]

  let text = ''
  let selectorUsed = candidates[0] ?? 'body'
  for (const sel of candidates) {
    try {
      const loc = page.locator(sel).first()
      const count = await loc.count()
      if (count === 0) continue
      const raw = await loc.innerText({ timeout: SNAPSHOT_TIMEOUT_MS })
      if (raw && raw.trim()) {
        text = raw
        selectorUsed = sel
        break
      }
    } catch {
      /* try next */
    }
  }

  if (!text.trim()) {
    try {
      text = await page.evaluate(() => document.body?.innerText ?? '')
      selectorUsed = opts.selector ?? 'body'
    } catch {
      text = ''
    }
  }

  const truncated = text.length > maxChars
  const bounded = truncated ? text.slice(0, maxChars) : text
  return {
    url: page.url(),
    title: await page.title().catch(() => ''),
    text: bounded,
    truncated,
    selectorUsed,
  }
}
