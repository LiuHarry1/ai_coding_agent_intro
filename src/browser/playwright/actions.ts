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
} from '../limits.js'
import { BrowserError, type BrowserBackend, type ResolvedElement } from '../types.js'
import {
  assertElementHint,
  describeElement,
  mapPlaywrightError,
  targetLocator,
} from './locator.js'
import { pickValue } from './pick.js'
import { handleDialog, peekDialog, throwIfUnarmedDestructiveDialog, uploadFiles } from './overlays.js'
import { settleIfUrlChanged, withActionWait } from './settle.js'
import { getPageForTarget } from './connect.js'
import { clearTabMemory, setTabPoisoned } from '../session-flags.js'
import { assertNavigateUrl } from '../navigate-policy.js'
import { SNAPSHOT_STALL_NEXT } from '../heavy-media.js'
import { ensureSnapshotFresh } from './snapshot.js'
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
} from './focus.js'

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
    x?: number
    y?: number
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
    | Array<'Alt' | 'Control' | 'Meta' | 'Shift'>
    | undefined
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
    if (opts.x != null && opts.y != null && !opts.ref) {
      const urlBefore = page.url()
      await withActionWait(page, async () => {
        await page.mouse.click(opts.x!, opts.y!, {
          button: opts.button,
          clickCount: opts.doubleClick ? 2 : 1,
        })
      })
      throwIfUnarmedDestructiveDialog(page)
      await afterNavigationLikeAction(page, targetId, urlBefore)
      return {
        ref: '',
        role: 'generic',
        name: `(${opts.x}, ${opts.y})`,
        tag: 'div',
      }
    }
    if (!opts.ref) {
      throw new BrowserError(
        'Provide ref from the latest snapshot, or x/y for a coordinate click.',
      )
    }
    await ensureSnapshotFresh(backend, targetId)
    const { loc, ref, described } = await resolveClickTarget(
      page,
      targetId,
      opts.ref,
      opts.element,
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
    )
    // A field the app computes rejects the write anyway. Returning its current
    // value makes the refusal visible instead of looking like a silent no-op.
    if (described.readOnly || described.disabled) return { ...described, ref }

    const value = await withActionWait(page, async () => {
      const timeout = ACTION_TIMEOUT_MS
      if (opts.slowly) {
        await loc.click({ timeout })
        await loc.type(opts.text, { timeout, delay: 75 })
      } else {
        await loc.fill(opts.text, { timeout })
      }
      if (opts.submit) await loc.press('Enter', { timeout })
      return loc
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
    const { loc } = await resolveClickTarget(page, targetId, ref, element)
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

function resolveViewportDimension(value: unknown, label: 'width' | 'height'): number {
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
): Promise<{ buffer: Buffer; format: 'png' | 'jpeg' }> {
  return withReadBoost(backend, targetId, async () => {
  const page: Page = await getPageForTarget(backend, targetId)
  const format = opts.format ?? 'png'
  const quality = format === 'jpeg' ? { quality: opts.quality ?? 80 } : {}
  try {
    if (opts.ref && opts.fullPage) {
      throw new BrowserError('fullPage is not supported for element screenshots')
    }
    const take = async () =>
      opts.ref
        ? await (
            await targetLocator(page, { ref: opts.ref, element: opts.element })
          ).screenshot({
            type: format,
            timeout: ACTION_TIMEOUT_MS,
            ...quality,
          })
        : await page.screenshot({
            type: format,
            fullPage: Boolean(opts.fullPage),
            timeout: ACTION_TIMEOUT_MS,
            ...quality,
          })
    const shot = await take()
    return { buffer: Buffer.from(shot), format }
  } catch (err) {
    if (!opts.ref && /Timeout|waiting/i.test(err instanceof Error ? err.message : String(err))) {
      throw new BrowserError(
        'Screenshot timed out (PDF/iframe viewers often stall it). Use browser_snapshot instead, or close the viewer first.',
      )
    }
    mapPlaywrightError(err, opts.ref)
  }
  })
}
