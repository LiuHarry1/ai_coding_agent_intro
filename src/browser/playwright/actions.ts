/**
 * Acting on a ref: `page.locator('aria-ref=eN')` plus Playwright's actionability
 * checks and trusted input.
 *
 * Elements are described *before* the action, not after. A button that says
 * "Clicked 0 times" says "Clicked 1 times" once you press it, and reporting the
 * after-state names something the model never chose — worse, an action that
 * navigates away leaves nothing to describe at all.
 */

import type { Page } from 'playwright-core'
import { ensureScript } from '../page-inspect.js'
import {
  ACTION_TIMEOUT_MS,
  NAVIGATE_SETTLE_MS,
  NAVIGATE_TIMEOUT_MS,
} from '../limits.js'
import type { BrowserBackend, ResolvedElement } from '../types.js'
import {
  describeElement,
  editableTarget,
  mapPlaywrightError,
  refLocator,
} from './locator.js'
import { writeText } from './fields.js'
import { withActionWait } from './settle.js'
import { getPageForTarget } from './connect.js'

export async function navigate(
  backend: BrowserBackend,
  targetId: string,
  url: string,
): Promise<void> {
  // Register the console/network hooks before the navigation they must survive,
  // so the next page is captured from its very first line.
  await ensureScript(backend, targetId)
  const page = await getPageForTarget(backend, targetId)
  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: NAVIGATE_TIMEOUT_MS,
    })
    await new Promise(r => setTimeout(r, NAVIGATE_SETTLE_MS))
  } catch (err) {
    mapPlaywrightError(err)
  }
}

export async function click(
  backend: BrowserBackend,
  targetId: string,
  opts: {
    ref: string
    button?: 'left' | 'right' | 'middle'
    doubleClick?: boolean
    modifiers?: string[]
  },
): Promise<ResolvedElement> {
  const page = await getPageForTarget(backend, targetId)
  const loc = refLocator(page, opts.ref)
  const modifiers = opts.modifiers as
    | Array<'Alt' | 'Control' | 'Meta' | 'Shift'>
    | undefined
  try {
    await page.bringToFront().catch(() => {})
    const described = await describeElement(loc, opts.ref)
    await withActionWait(page, async () => {
      const args = {
        timeout: ACTION_TIMEOUT_MS,
        noWaitAfter: true,
        button: opts.button,
        modifiers,
      }
      if (opts.doubleClick) await loc.dblclick(args)
      else await loc.click(args)
    })
    return described
  } catch (err) {
    mapPlaywrightError(err, opts.ref)
  }
}

export async function hover(
  backend: BrowserBackend,
  targetId: string,
  opts: { ref: string },
): Promise<ResolvedElement> {
  const page = await getPageForTarget(backend, targetId)
  const loc = refLocator(page, opts.ref)
  try {
    await page.bringToFront().catch(() => {})
    const described = await describeElement(loc, opts.ref)
    await loc.hover({ timeout: ACTION_TIMEOUT_MS })
    return described
  } catch (err) {
    mapPlaywrightError(err, opts.ref)
  }
}

export async function typeText(
  backend: BrowserBackend,
  targetId: string,
  opts: {
    ref: string
    text: string
    slowly?: boolean
    submit?: boolean
  },
): Promise<ResolvedElement> {
  const page = await getPageForTarget(backend, targetId)
  const loc = refLocator(page, opts.ref)
  try {
    await page.bringToFront().catch(() => {})
    const described = await describeElement(loc, opts.ref)
    // A field the app computes rejects the write anyway. Returning its current
    // value makes the refusal visible instead of looking like a silent no-op.
    if (described.readOnly || described.disabled) return described

    const field = editableTarget(loc, described)
    const value = await withActionWait(page, async () => {
      const got = await writeText(page, field, opts.text, {
        slowly: opts.slowly,
      })
      if (opts.submit) await page.keyboard.press('Enter')
      return got
    })
    return { ...described, value }
  } catch (err) {
    mapPlaywrightError(err, opts.ref)
  }
}

export async function selectOption(
  backend: BrowserBackend,
  targetId: string,
  ref: string,
  values: string[],
): Promise<{ selected: string[] }> {
  const page = await getPageForTarget(backend, targetId)
  const loc = refLocator(page, ref)
  try {
    await loc.selectOption(values, { timeout: ACTION_TIMEOUT_MS })
    // Playwright hands back the option *values*. The model chose the label it
    // saw in the snapshot, so echoing `prod` for "Production" reads like a
    // different choice than the one it made.
    const selected = await loc
      .evaluate(node =>
        Array.from((node as HTMLSelectElement).selectedOptions ?? []).map(
          o => (o.textContent || '').replace(/\s+/g, ' ').trim() || o.value,
        ),
      )
      .catch(() => values)
    return { selected }
  } catch (err) {
    mapPlaywrightError(err, ref)
  }
}

export async function pressKey(
  backend: BrowserBackend,
  targetId: string,
  key: string,
  modifiers?: string[],
): Promise<void> {
  const page = await getPageForTarget(backend, targetId)
  const combo = [...(modifiers ?? []), key].join('+')
  try {
    await page.bringToFront().catch(() => {})
    await withActionWait(page, async () => {
      await page.keyboard.press(combo)
    })
  } catch (err) {
    mapPlaywrightError(err)
  }
}

export async function scroll(
  backend: BrowserBackend,
  targetId: string,
  opts: { deltaX?: number; deltaY?: number; ref?: string },
): Promise<void> {
  const page = await getPageForTarget(backend, targetId)
  const deltaX = opts.deltaX ?? 0
  const deltaY = opts.deltaY ?? 0
  try {
    await page.bringToFront().catch(() => {})
    if (!opts.ref) {
      await page.mouse.wheel(deltaX, deltaY)
      return
    }
    const loc = refLocator(page, opts.ref)
    await loc.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS })
    // The page itself is often not what scrolls: the element sits in a pane
    // with its own overflow, so walk up to whichever ancestor can move.
    await loc.evaluate(
      (el, delta) => {
        let node: HTMLElement | null = el as HTMLElement
        while (node && node !== document.documentElement) {
          const style = getComputedStyle(node)
          const canY =
            (style.overflowY === 'auto' ||
              style.overflowY === 'scroll' ||
              style.overflowY === 'overlay') &&
            node.scrollHeight > node.clientHeight + 1
          const canX =
            (style.overflowX === 'auto' ||
              style.overflowX === 'scroll' ||
              style.overflowX === 'overlay') &&
            node.scrollWidth > node.clientWidth + 1
          if (canY || canX) {
            node.scrollBy(delta.x, delta.y)
            return
          }
          node = node.parentElement
        }
        window.scrollBy(delta.x, delta.y)
      },
      { x: deltaX, y: deltaY },
    )
  } catch (err) {
    mapPlaywrightError(err, opts.ref)
  }
}

export async function screenshot(
  backend: BrowserBackend,
  targetId: string,
  opts: {
    ref?: string
    fullPage?: boolean
    format?: 'png' | 'jpeg'
    quality?: number
  } = {},
): Promise<{ buffer: Buffer; format: 'png' | 'jpeg' }> {
  const page: Page = await getPageForTarget(backend, targetId)
  const format = opts.format ?? 'png'
  const quality = format === 'jpeg' ? { quality: opts.quality ?? 80 } : {}
  try {
    const shot = opts.ref
      ? await refLocator(page, opts.ref).screenshot({
          type: format,
          timeout: ACTION_TIMEOUT_MS,
          ...quality,
        })
      : await page.screenshot({
          type: format,
          fullPage: opts.fullPage,
          timeout: ACTION_TIMEOUT_MS,
          ...quality,
        })
    return { buffer: Buffer.from(shot), format }
  } catch (err) {
    mapPlaywrightError(err, opts.ref)
  }
}
