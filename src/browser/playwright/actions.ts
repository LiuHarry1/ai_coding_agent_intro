/**
 * Acting on a ref: `page.locator('aria-ref=eN')` plus Playwright's actionability
 * checks and trusted input — aligned with Playwright MCP's `targetLocator` flow.
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
  ACT_MAX_VIEWPORT_DIMENSION,
  NAVIGATE_SETTLE_MS,
  NAVIGATE_TIMEOUT_MS,
  SCREENSHOT_TIMEOUT_MS,
} from '../limits.js'
import {
  BrowserError,
  type BrowserBackend,
  type ResolvedElement,
} from '../types.js'
import { DATE_RANGE_CALENDAR_MSG, isTypedDateRange } from './fields.js'
import {
  assertElementHint,
  describeElement,
  editableLocator,
  mapPlaywrightError,
  targetLocator,
} from './locator.js'
import { pickValue } from './pick.js'
import {
  handleDialog,
  peekDialog,
  throwIfUnarmedDestructiveDialog,
  uploadFiles,
} from './overlays.js'
import { settleIfUrlChanged, withActionWait } from './settle.js'
import { getPageForTarget } from './connect.js'
import { clearTabMemory, setTabPoisoned } from '../session-flags.js'
import { assertNavigateUrl } from '../navigate-policy.js'
import { SNAPSHOT_STALL_NEXT } from '../heavy-media.js'
import {
  clearViewportScreenshot,
  getViewportScreenshot,
} from '../viewport-screenshot-cache.js'
import {
  ensureSnapshotFresh,
  forceRefreshSnapshot,
  withHeavyMediaHidden,
} from './snapshot.js'
import {
  clickLocatorRobust,
  ensureInView,
  resolveClickTarget,
  type RobustClickOpts,
} from './robust-click.js'
import {
  ensureTabFocus,
  withInputFocus,
  withReadBoost,
  withVisualFocus,
} from './focus.js'
import { captureViewport } from './viewport-capture.js'

function staleRecovery(
  backend: BrowserBackend,
  targetId: string,
  retryOnStaleRef?: boolean,
) {
  return {
    retryOnStaleRef: retryOnStaleRef !== false,
    refreshSnapshot: () => forceRefreshSnapshot(backend, targetId),
  }
}

export async function navigate(
  backend: BrowserBackend,
  targetId: string,
  dest: { url?: string; action?: 'back' | 'forward' | 'reload' },
): Promise<void> {
  await ensureScript(backend, targetId)
  await withReadBoost(backend, targetId, async () => {
    const page = await getPageForTarget(backend, targetId)
    try {
      if (dest.action === 'back') {
        await page.goBack({
          waitUntil: 'domcontentloaded',
          timeout: NAVIGATE_TIMEOUT_MS,
        })
      } else if (dest.action === 'forward') {
        await page.goForward({
          waitUntil: 'domcontentloaded',
          timeout: NAVIGATE_TIMEOUT_MS,
        })
      } else if (dest.action === 'reload') {
        await page.reload({
          waitUntil: 'domcontentloaded',
          timeout: NAVIGATE_TIMEOUT_MS,
        })
      } else {
        if (!dest.url) {
          throw new BrowserError(
            'navigate requires a url, or action back/forward/reload.',
          )
        }
        const href = assertNavigateUrl(dest.url)
        await page.goto(href, {
          waitUntil: 'domcontentloaded',
          timeout: NAVIGATE_TIMEOUT_MS,
        })
      }
      clearTabMemory(targetId)
      await new Promise(r => setTimeout(r, NAVIGATE_SETTLE_MS))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (/Timeout/i.test(message)) {
        setTabPoisoned(targetId)
        throw new BrowserError(
          `Navigation timed out. Stay on this tab — do not retry navigate. ${SNAPSHOT_STALL_NEXT}`,
        )
      }
      mapPlaywrightError(err)
    }
  })
}

/** Make this tab the visible one and give a SPA a beat to refetch. */
export async function activateTab(
  backend: BrowserBackend,
  targetId: string,
): Promise<void> {
  await ensureTabFocus(backend, targetId, 'tab')
  await new Promise(r => setTimeout(r, NAVIGATE_SETTLE_MS))
}

async function afterNavigationLikeAction(
  page: Page,
  targetId: string,
  urlBefore: string,
): Promise<void> {
  await settleIfUrlChanged(page, urlBefore, targetId)
}

export async function click(
  backend: BrowserBackend,
  targetId: string,
  opts: {
    ref?: string
    element?: string
    button?: 'left' | 'right' | 'middle'
    doubleClick?: boolean
    modifiers?: string[]
    force?: boolean
    offsetX?: number
    offsetY?: number
    maxScrollAttempts?: number
    retryOnStaleRef?: boolean
    autoCloseDropdowns?: boolean
    retryWithOffset?: boolean
  },
): Promise<ResolvedElement> {
  return withInputFocus(backend, targetId, async () => {
    const page = await getPageForTarget(backend, targetId)
    const modifiers = opts.modifiers as
      Array<'Alt' | 'Control' | 'Meta' | 'Shift'> | undefined
    const robust: RobustClickOpts = {
      button: opts.button,
      doubleClick: opts.doubleClick,
      modifiers,
      offsetX: opts.offsetX,
      offsetY: opts.offsetY,
      force: opts.force,
      maxScrollAttempts: opts.maxScrollAttempts,
      retryOnStaleRef: opts.retryOnStaleRef,
      autoCloseDropdowns: opts.autoCloseDropdowns,
      retryWithOffset: opts.retryWithOffset,
    }
    try {
      if (!opts.ref) {
        throw new BrowserError('Provide ref from the latest snapshot.')
      }
      await ensureSnapshotFresh(backend, targetId)
      const { loc, ref, described } = await resolveClickTarget(
        page,
        targetId,
        opts.ref,
        opts.element,
        staleRecovery(backend, targetId, opts.retryOnStaleRef),
      )
      const urlBefore = page.url()
      await withActionWait(page, async () => {
        await clickLocatorRobust(page, loc, robust)
      })
      throwIfUnarmedDestructiveDialog(page)
      await afterNavigationLikeAction(page, targetId, urlBefore)
      return { ...described, ref }
    } catch (err) {
      mapPlaywrightError(err, opts.ref)
    }
  })
}

export async function mouseClickXY(
  backend: BrowserBackend,
  targetId: string,
  opts: {
    x: number
    y: number
    button?: 'left' | 'right' | 'middle'
    doubleClick?: boolean
  },
): Promise<
  ResolvedElement & {
    screenshotCoordinates: { x: number; y: number }
    viewportCoordinates: { x: number; y: number }
  }
> {
  return withInputFocus(backend, targetId, async () => {
    const page = await getPageForTarget(backend, targetId)
    const screenshot = getViewportScreenshot(backend, targetId)
    if (!screenshot) {
      throw new BrowserError(
        'browser_mouse_click_xy needs a fresh viewport screenshot for this tab. ' +
          'Call browser_screenshot without labels or ref immediately before this tool; any other browser tool call invalidates it. ' +
          'Coordinates are pixels in that image, not label box values.',
      )
    }
    const screenshotX = Math.round(opts.x)
    const screenshotY = Math.round(opts.y)
    if (!Number.isFinite(screenshotX) || !Number.isFinite(screenshotY)) {
      throw new BrowserError('Coordinate click requires finite x and y values.')
    }
    if (
      screenshotX < 0 ||
      screenshotY < 0 ||
      screenshotX >= screenshot.sentImageWidth ||
      screenshotY >= screenshot.sentImageHeight
    ) {
      throw new BrowserError(
        `Coordinate (${screenshotX}, ${screenshotY}) is outside the latest screenshot ` +
          `${screenshot.sentImageWidth}x${screenshot.sentImageHeight}.`,
      )
    }
    if (page.url() !== screenshot.url) {
      clearViewportScreenshot(backend, targetId)
      throw new BrowserError(
        'browser_mouse_click_xy needs a fresh screenshot. The page URL changed since the latest screenshot.',
      )
    }
    const viewport =
      page.viewportSize() ??
      (await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      })))
    if (
      viewport.width !== screenshot.viewportCssWidth ||
      viewport.height !== screenshot.viewportCssHeight
    ) {
      clearViewportScreenshot(backend, targetId)
      throw new BrowserError(
        'browser_mouse_click_xy needs a fresh screenshot. The viewport changed since the latest screenshot.',
      )
    }
    const x = Math.round(
      (screenshotX * screenshot.viewportCssWidth) / screenshot.sentImageWidth,
    )
    const y = Math.round(
      (screenshotY * screenshot.viewportCssHeight) / screenshot.sentImageHeight,
    )
    if (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) {
      throw new BrowserError(
        `Coordinate (${x}, ${y}) is outside viewport ${viewport.width}x${viewport.height}.`,
      )
    }

    const hit = await page.evaluate(
      ({ x, y }) => {
        const target = document.elementFromPoint(x, y) as HTMLElement | null
        if (!target) return null
        return {
          target: {
            tag: target.tagName.toLowerCase(),
            role: target.getAttribute('role') || 'generic',
            name: (
              target.getAttribute('aria-label') ||
              target.getAttribute('title') ||
              target.textContent ||
              ''
            )
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 80),
          },
        }
      },
      { x, y },
    )
    if (!hit) {
      throw new BrowserError(
        `Coordinate (${x}, ${y}) does not hit a page element.`,
      )
    }

    const urlBefore = page.url()
    throwIfUnarmedDestructiveDialog(page)
    await withActionWait(page, () =>
      page.mouse.click(x, y, {
        button: opts.button,
        clickCount: opts.doubleClick ? 2 : 1,
      }),
    )
    throwIfUnarmedDestructiveDialog(page)
    await afterNavigationLikeAction(page, targetId, urlBefore)
    clearViewportScreenshot(backend, targetId)
    return {
      ref: '',
      role: hit.target.role,
      name: hit.target.name || `(${x}, ${y})`,
      tag: hit.target.tag,
      screenshotCoordinates: { x: screenshotX, y: screenshotY },
      viewportCoordinates: { x, y },
    }
  })
}

export async function drag(
  backend: BrowserBackend,
  targetId: string,
  opts: { startRef: string; endRef: string },
): Promise<void> {
  return withInputFocus(backend, targetId, async () => {
  const page = await getPageForTarget(backend, targetId)
  try {
    await ensureSnapshotFresh(backend, targetId)
    const start = await targetLocator(page, { ref: opts.startRef })
    const end = await targetLocator(page, { ref: opts.endRef })
    await ensureInView(start, page)
    await ensureInView(end, page)
    const urlBefore = page.url()
    await withActionWait(page, async () => {
      await start.dragTo(end, { timeout: ACTION_TIMEOUT_MS })
    })
    throwIfUnarmedDestructiveDialog(page)
    await afterNavigationLikeAction(page, targetId, urlBefore)
  } catch (err) {
    mapPlaywrightError(err, opts.startRef)
  }
  })
}

export async function hover(
  backend: BrowserBackend,
  targetId: string,
  opts: { ref: string; element?: string },
): Promise<ResolvedElement> {
  return withInputFocus(backend, targetId, async () => {
  const page = await getPageForTarget(backend, targetId)
  try {
    await ensureSnapshotFresh(backend, targetId)
    const { loc, ref, described } = await resolveClickTarget(
      page,
      targetId,
      opts.ref,
      opts.element,
      staleRecovery(backend, targetId),
    )
    await withActionWait(page, async () => {
      await ensureInView(loc, page)
      await loc.hover({ timeout: ACTION_TIMEOUT_MS })
    })
    return { ...described, ref }
  } catch (err) {
    mapPlaywrightError(err, opts.ref)
  }
  })
}

export async function typeText(
  backend: BrowserBackend,
  targetId: string,
  opts: {
    ref: string
    text: string
    slowly?: boolean
    submit?: boolean
    element?: string
  },
): Promise<ResolvedElement> {
  return withInputFocus(backend, targetId, async () => {
  const page = await getPageForTarget(backend, targetId)
  try {
    await ensureSnapshotFresh(backend, targetId)
    const { loc, ref, described } = await resolveClickTarget(
      page,
      targetId,
      opts.ref,
      opts.element,
      staleRecovery(backend, targetId),
    )
    // A field the app computes rejects the write anyway. Returning its current
    // value makes the refusal visible instead of looking like a silent no-op.
    if (described.readOnly || described.disabled) return { ...described, ref }

    if (isTypedDateRange(described.name, opts.text)) {
      throw new BrowserError(DATE_RANGE_CALENDAR_MSG)
    }

    const writeLoc = editableLocator(loc, described.field)
    const value = await withActionWait(page, async () => {
      const timeout = ACTION_TIMEOUT_MS
      if (opts.slowly) {
        await writeLoc.click({ timeout })
        await writeLoc.type(opts.text, { timeout, delay: 75 })
      } else {
        await writeLoc.fill(opts.text, { timeout })
      }
      if (opts.submit) await writeLoc.press('Enter', { timeout })
      return writeLoc
        .evaluate(node => {
          const t = node as HTMLInputElement
          return t.isContentEditable
            ? ((t as unknown as HTMLElement).innerText || '').trim()
            : (t.value ?? '')
        })
        .catch(() => opts.text)
    })
    throwIfUnarmedDestructiveDialog(page)
    return { ...described, ref, value }
  } catch (err) {
    mapPlaywrightError(err, opts.ref)
  }
  })
}

export async function selectOption(
  backend: BrowserBackend,
  targetId: string,
  ref: string,
  values: string[],
  element?: string,
): Promise<{ selected: string[] }> {
  return withInputFocus(backend, targetId, async () => {
  const page = await getPageForTarget(backend, targetId)
  try {
    await ensureSnapshotFresh(backend, targetId)
    const { loc } = await resolveClickTarget(
      page,
      targetId,
      ref,
      element,
      staleRecovery(backend, targetId),
    )
    const selected = await withActionWait(page, () => pickValue(loc, values))
    throwIfUnarmedDestructiveDialog(page)
    return selected
  } catch (err) {
    mapPlaywrightError(err, ref)
  }
  })
}

export async function peekNativeDialog(
  backend: BrowserBackend,
  targetId: string,
): Promise<
  | { type: string; message: string; accepted: boolean; pending?: boolean }
  | undefined
> {
  const page = await getPageForTarget(backend, targetId)
  return peekDialog(page)
}

export async function handleNativeDialog(
  backend: BrowserBackend,
  targetId: string,
  opts: { accept: boolean; promptText?: string },
): Promise<{
  type: string
  message: string
  accepted: boolean
  armed?: boolean
}> {
  const page = await getPageForTarget(backend, targetId)
  try {
    return await handleDialog(page, opts)
  } catch (err) {
    mapPlaywrightError(err)
  }
}

export async function uploadFilesToPage(
  backend: BrowserBackend,
  targetId: string,
  opts: { paths: string[]; ref?: string },
): Promise<{ files: string[]; cancelled: boolean }> {
  return withInputFocus(backend, targetId, async () => {
  const page = await getPageForTarget(backend, targetId)
  try {
    // No network drain: attaching a file often starts a PDF/viewer fetch that
    // never goes idle, and waiting for it is what made upload look hung.
    return await uploadFiles(page, opts)
  } catch (err) {
    mapPlaywrightError(err, opts.ref)
  }
  })
}

export async function pressKey(
  backend: BrowserBackend,
  targetId: string,
  key: string,
  modifiers?: string[],
): Promise<void> {
  return withInputFocus(backend, targetId, async () => {
  const page = await getPageForTarget(backend, targetId)
  const combo = [...(modifiers ?? []), key].join('+')
  try {
    await withActionWait(page, async () => {
      await page.keyboard.press(combo)
    })
    throwIfUnarmedDestructiveDialog(page)
  } catch (err) {
    mapPlaywrightError(err)
  }
  })
}

function resolveViewportDimension(
  value: unknown,
  label: 'width' | 'height',
): number {
  const dimension = Math.floor(Number(value))
  if (!Number.isFinite(dimension) || dimension < 1) {
    throw new BrowserError(`viewport ${label} must be >= 1`)
  }
  if (dimension > ACT_MAX_VIEWPORT_DIMENSION) {
    throw new BrowserError(
      `viewport ${label} exceeds maximum of ${ACT_MAX_VIEWPORT_DIMENSION}`,
    )
  }
  return dimension
}

export async function resizeViewport(
  backend: BrowserBackend,
  targetId: string,
  width: number,
  height: number,
): Promise<void> {
  const page = await getPageForTarget(backend, targetId)
  await page.setViewportSize({
    width: resolveViewportDimension(width, 'width'),
    height: resolveViewportDimension(height, 'height'),
  })
}

export async function scrollIntoView(
  backend: BrowserBackend,
  targetId: string,
  ref: string,
  element?: string,
): Promise<void> {
  return withInputFocus(backend, targetId, async () => {
  const page = await getPageForTarget(backend, targetId)
  try {
    const loc = await targetLocator(page, { ref, element })
    await loc.scrollIntoViewIfNeeded({
      timeout: ACTION_TIMEOUT_MS,
    })
  } catch (err) {
    mapPlaywrightError(err, ref)
  }
  })
}

export async function scroll(
  backend: BrowserBackend,
  targetId: string,
  opts: {
    deltaX?: number
    deltaY?: number
    ref?: string
    scrollIntoView?: boolean
    direction?: 'up' | 'down' | 'left' | 'right'
    amount?: number
    element?: string
  },
): Promise<void> {
  return withInputFocus(backend, targetId, async () => {
  const page = await getPageForTarget(backend, targetId)
  const amount = opts.amount ?? 300
  let deltaX = opts.deltaX ?? 0
  let deltaY = opts.deltaY ?? 0
  if (opts.direction === 'up') deltaY = -amount
  if (opts.direction === 'down') deltaY = amount
  if (opts.direction === 'left') deltaX = -amount
  if (opts.direction === 'right') deltaX = amount
  try {
    if (opts.scrollIntoView && opts.ref) {
      const loc = await targetLocator(page, {
        ref: opts.ref,
        element: opts.element,
      })
      await loc.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS })
      return
    }
    if (!opts.ref) {
      await page.mouse.wheel(deltaX, deltaY || (deltaX ? 0 : 500))
      return
    }
    const loc = await targetLocator(page, { ref: opts.ref, element: opts.element })
    await loc.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS })
    if (deltaX || deltaY) await page.mouse.wheel(deltaX, deltaY)
  } catch (err) {
    mapPlaywrightError(err, opts.ref)
  }
  })
}

export async function screenshot(
  backend: BrowserBackend,
  targetId: string,
  opts: {
    ref?: string
    fullPage?: boolean
    format?: 'png' | 'jpeg'
    quality?: number
    element?: string
  } = {},
): Promise<{
  buffer: Buffer
  format: 'png' | 'jpeg'
  url: string
  viewport: { width: number; height: number }
}> {
  return withVisualFocus(backend, targetId, async () => {
    const page: Page = await getPageForTarget(backend, targetId)
    const format = opts.format ?? 'png'
    const quality = format === 'jpeg' ? { quality: opts.quality ?? 80 } : {}
    try {
      if (opts.ref && opts.fullPage) {
        throw new BrowserError(
          'fullPage is not supported for element screenshots',
        )
      }
      const take = async () =>
        opts.ref
          ? await (
              await targetLocator(page, {
                ref: opts.ref,
                element: opts.element,
              })
            ).screenshot({
              type: format,
              timeout: SCREENSHOT_TIMEOUT_MS,
              ...quality,
            })
          : opts.fullPage
            ? await page.screenshot({
                type: format,
                fullPage: true,
                timeout: SCREENSHOT_TIMEOUT_MS,
                ...quality,
              })
            : await captureViewport(backend, targetId, page, {
                type: format,
                ...quality,
              })
      // Same as snapshot: PDF/receipt iframes stall Chrome's compositor.
      const shot = await withHeavyMediaHidden(page, take)
      const viewport =
        page.viewportSize() ??
        (await page.evaluate(() => ({
          width: window.innerWidth,
          height: window.innerHeight,
        })))
      return { buffer: Buffer.from(shot), format, url: page.url(), viewport }
    } catch (err) {
      if (
        !opts.ref &&
        /Timeout|waiting/i.test(
          err instanceof Error ? err.message : String(err),
        )
      ) {
        throw new BrowserError(
          'Screenshot timed out (PDF/iframe receipt previews often stall it). Do not retry screenshot in a loop. Prefer a compact accessibility snapshot after the next form action, or keep filling visible form controls if they are already known.',
        )
      }
      mapPlaywrightError(err, opts.ref)
    }
  })
}
