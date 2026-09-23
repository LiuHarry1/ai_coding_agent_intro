/**
 * Cursor-style click prep: scroll into view, stale-ref recovery, dropdown dismiss,
 * offset retry, and intercept diagnosis when a layer still blocks the target.
 */

import type { Locator, Page } from 'playwright-core'
import {
  parseExpectedDescription,
  parseRefMeta,
  pickRecoveredRef,
} from '../snapshot-index.js'
import { getLastSnapshot, getRefMeta } from '../session-flags.js'
import { BrowserError, StaleRefError } from '../types.js'
import {
  assertElementHint,
  describeElement,
  type DescribedElement,
  normalizeRef,
  targetLocator,
} from './locator.js'

export const DEFAULT_MAX_SCROLL_ATTEMPTS = 5
export const VIEWPORT_EDGE_TOLERANCE_PX = 10

export interface RectLike {
  x: number
  y: number
  width: number
  height: number
}

export interface ViewportLike {
  width: number
  height: number
}

/**
 * Cursor accepts a small edge tolerance after scrolling, but never treats a
 * detached popup parked thousands of pixels offscreen as interactable.
 * An axis longer than the viewport can never be fully contained, so on that
 * axis any overlap counts and the click lands in the visible intersection.
 */
export function isBoxInViewport(
  box: RectLike,
  viewport: ViewportLike,
  tolerance = VIEWPORT_EDGE_TOLERANCE_PX,
): boolean {
  const values = [
    box.x,
    box.y,
    box.width,
    box.height,
    viewport.width,
    viewport.height,
  ]
  if (!values.every(Number.isFinite)) return false
  if (
    box.width <= 0 ||
    box.height <= 0 ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    return false
  }
  const right = box.x + box.width
  const bottom = box.y + box.height
  const intersects =
    right > 0 && bottom > 0 && box.x < viewport.width && box.y < viewport.height
  const containedX =
    box.width > viewport.width + 2 * tolerance ||
    (box.x >= -tolerance && right <= viewport.width + tolerance)
  const containedY =
    box.height > viewport.height + 2 * tolerance ||
    (box.y >= -tolerance && bottom <= viewport.height + tolerance)
  return intersects && containedX && containedY
}

export function visibleClickPosition(
  box: RectLike,
  viewport: ViewportLike,
  preferred: { x: number; y: number },
): { x: number; y: number } {
  const visibleLeft = Math.max(box.x, 0)
  const visibleTop = Math.max(box.y, 0)
  const visibleRight = Math.min(box.x + box.width, viewport.width)
  const visibleBottom = Math.min(box.y + box.height, viewport.height)
  const insetX = Math.min(1, (visibleRight - visibleLeft) / 4)
  const insetY = Math.min(1, (visibleBottom - visibleTop) / 4)
  const clamp = (value: number, min: number, max: number) =>
    Math.min(Math.max(value, min), max)
  return {
    x:
      clamp(box.x + preferred.x, visibleLeft + insetX, visibleRight - insetX) -
      box.x,
    y:
      clamp(box.y + preferred.y, visibleTop + insetY, visibleBottom - insetY) -
      box.y,
  }
}

async function pageViewport(page: Page): Promise<ViewportLike> {
  const configured = page.viewportSize()
  if (configured) return configured
  return page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }))
}

async function elementVisibility(loc: Locator): Promise<{
  connected: boolean
  hasClientRect: boolean
  display: string
  visibility: string
  opacity: number
  pointerEvents: string
} | null> {
  return loc
    .evaluate(el => {
      const node = el as HTMLElement
      const style = window.getComputedStyle(node)
      return {
        connected: node.isConnected,
        hasClientRect: node.getClientRects().length > 0,
        display: style.display,
        visibility: style.visibility,
        opacity: Number.parseFloat(style.opacity || '1'),
        pointerEvents: style.pointerEvents,
      }
    })
    .catch(() => null)
}

function visibilityFailure(
  state: Awaited<ReturnType<typeof elementVisibility>>,
): string | undefined {
  if (!state?.connected) return 'Element is detached from the document.'
  if (!state.hasClientRect || state.display === 'none') {
    return 'Element is hidden and has no visible layout box.'
  }
  if (state.visibility === 'hidden' || state.visibility === 'collapse') {
    return `Element has visibility: ${state.visibility}.`
  }
  if (Number.isFinite(state.opacity) && state.opacity <= 0) {
    return 'Element is fully transparent (opacity: 0).'
  }
  if (state.pointerEvents === 'none') {
    return 'Element has pointer-events: none.'
  }
  return undefined
}

export function recoverRefByHint(
  targetId: string,
  ref: string,
  elementHint?: string,
  knownRole?: string,
): string | undefined {
  const yaml = getLastSnapshot(targetId)
  if (!yaml) return undefined
  const parsed = parseExpectedDescription(elementHint)
  const known = getRefMeta(targetId, ref)
  return pickRecoveredRef(parseRefMeta(yaml), {
    oldRef: ref,
    role: parsed.role ?? knownRole ?? known?.role ?? null,
    name: parsed.name ?? known?.name ?? null,
  })
}

export async function ensureInView(
  loc: Locator,
  page: Page,
  maxAttempts = DEFAULT_MAX_SCROLL_ATTEMPTS,
): Promise<void> {
  let lastBox: RectLike | null = null
  let lastViewport: ViewportLike | null = null
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await loc.scrollIntoViewIfNeeded({ timeout: 2_000 })
      const box = await loc.boundingBox()
      const viewport = await pageViewport(page)
      lastBox = box
      lastViewport = viewport
      if (box && isBoxInViewport(box, viewport)) {
        const failure = visibilityFailure(await elementVisibility(loc))
        if (failure) throw new BrowserError(failure)
        return
      }
      // Playwright normally scrolls nested containers itself. Centering is a
      // safe fallback for legacy widgets that keep the target at a clipped
      // edge while reporting scrollIntoViewIfNeeded as complete.
      await loc
        .evaluate(el =>
          (el as HTMLElement).scrollIntoView({
            block: 'center',
            inline: 'center',
            behavior: 'instant',
          }),
        )
        .catch(() => {})
    } catch {
      /* scroll and retry */
    }
    await page.waitForTimeout(100)
  }

  const state = await elementVisibility(loc)
  const failure = visibilityFailure(state)
  if (failure) {
    if (!state?.connected) throw new StaleRefError(failure)
    throw new BrowserError(failure)
  }
  if (!lastBox) {
    throw new StaleRefError(
      'Element has no bounding box. Capture a new snapshot and retry.',
    )
  }
  const viewport = lastViewport ?? (await pageViewport(page))
  throw new BrowserError(
    `Element remains outside the visible viewport after ${maxAttempts} scroll attempts ` +
      `(box x=${Math.round(lastBox.x)}, y=${Math.round(lastBox.y)}, ` +
      `width=${Math.round(lastBox.width)}, height=${Math.round(lastBox.height)}; ` +
      `viewport ${viewport.width}x${viewport.height}). Capture a new snapshot; ` +
      `do not force-click this ref.`,
  )
}

export interface DropdownDismissal {
  detected: boolean
  closed: boolean
  method?: 'click-body' | 'escape-on-field'
  dropdown?: string
}

/**
 * Cursor's `attemptDropdownClose`: act only when the layer covering the target
 * is a dropdown, and never with a trusted key press or a real mouse click.
 * Legacy apps (Concur/ExtJS) bind a document-level Escape to "cancel edit",
 * and a real click at a fixed corner can hit arbitrary chrome, so a blind
 * Escape + corner click used to open "Your changes may be lost" itself.
 * Modals and message boxes are left alone for the model to answer.
 */
const DROPDOWN_ATTR = 'data-baix-covering-dropdown'
const DROPDOWN_SETTLE_MS = 100

export async function dismissBlockingDropdown(
  loc: Locator,
  offset: { x: number; y: number },
): Promise<DropdownDismissal> {
  const none: DropdownDismissal = { detected: false, closed: false }
  // No named inner functions in page code: the bundler rewrites them into
  // `__name` calls that do not exist in the page.
  const label = await loc
    .evaluate(
      (target, args) => {
        const doc = target.ownerDocument
        const win = doc.defaultView ?? window
        const rect = target.getBoundingClientRect()
        const hit = doc.elementFromPoint(
          rect.left + args.off.x,
          rect.top + args.off.y,
        )
        if (!hit || hit === target || target.contains(hit)) return null
        const modalClass = /\b(x-window|x-message-box|x-mask|modal)\b/
        const dropdownClass =
          /\b(dropdown|boundlist|datepicker|picker|autocomplete|suggestions|popover|menu-list|option-list)\b/
        let dropdown: Element | null = null
        for (
          let el: Element | null = hit;
          el && el !== doc.body;
          el = el.parentElement
        ) {
          const role = el.getAttribute('role') || ''
          const cls =
            typeof el.className === 'string' ? el.className.toLowerCase() : ''
          if (
            el.tagName === 'DIALOG' ||
            role === 'dialog' ||
            role === 'alertdialog' ||
            el.getAttribute('aria-modal') === 'true' ||
            modalClass.test(cls)
          ) {
            return null
          }
          let isDropdown =
            role === 'listbox' ||
            role === 'menu' ||
            role === 'tree' ||
            el.tagName === 'SELECT' ||
            el.tagName === 'DATALIST' ||
            dropdownClass.test(cls)
          if (!isDropdown) {
            const style = win.getComputedStyle(el)
            const z = Number.parseInt(style.zIndex, 10)
            isDropdown =
              (style.position === 'absolute' || style.position === 'fixed') &&
              Number.isFinite(z) &&
              z > 10 &&
              el.querySelector(
                '[role="option"], [role="menuitem"], option, li',
              ) !== null
          }
          if (isDropdown) {
            dropdown = el
            break
          }
        }
        if (!dropdown || dropdown.contains(target)) return null
        dropdown.setAttribute(args.attr, '')
        return (
          dropdown.getAttribute('aria-label') ||
          dropdown.getAttribute('role') ||
          dropdown.tagName.toLowerCase()
        ).slice(0, 60)
      },
      { off: offset, attr: DROPDOWN_ATTR },
    )
    .catch(() => null)
  if (label === null) return none

  const gone = () =>
    loc
      .evaluate((target, attr) => {
        const doc = target.ownerDocument
        const win = doc.defaultView ?? window
        const el = doc.querySelector(`[${attr}]`)
        if (!el || !el.isConnected) return true
        const style = win.getComputedStyle(el)
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          Number.parseFloat(style.opacity || '1') <= 0
        ) {
          return true
        }
        // ExtJS hides pickers by moving them offscreen, not display:none.
        const box = el.getBoundingClientRect()
        return (
          (box.width === 0 && box.height === 0) ||
          box.right <= 0 ||
          box.bottom <= 0 ||
          box.left >= win.innerWidth ||
          box.top >= win.innerHeight
        )
      }, DROPDOWN_ATTR)
      .catch(() => false)

  const settle = () => loc.page().waitForTimeout(DROPDOWN_SETTLE_MS)
  let result: DropdownDismissal = { detected: true, closed: false, dropdown: label }
  try {
    await loc.evaluate(target => {
      const doc = target.ownerDocument
      const win = doc.defaultView ?? window
      for (const type of ['mousedown', 'mouseup', 'click']) {
        doc.body.dispatchEvent(
          new win.MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            view: win,
            clientX: 0,
            clientY: 0,
          }),
        )
      }
    })
    await settle()
    if (await gone()) {
      result = { ...result, closed: true, method: 'click-body' }
      return result
    }
    // Non-bubbling: the owning field's key handler sees it, a document-level
    // "cancel form" handler does not.
    const sent = await loc.evaluate((target, attr) => {
      const doc = target.ownerDocument
      const win = doc.defaultView ?? window
      const field = doc.activeElement
      const dropdown = doc.querySelector(`[${attr}]`)
      if (!field || field === doc.body || dropdown?.contains(field)) {
        return false
      }
      field.dispatchEvent(
        new win.KeyboardEvent('keydown', {
          key: 'Escape',
          code: 'Escape',
          keyCode: 27,
          which: 27,
          bubbles: false,
          cancelable: true,
        }),
      )
      return true
    }, DROPDOWN_ATTR)
    if (sent) {
      await settle()
      if (await gone()) {
        result = { ...result, closed: true, method: 'escape-on-field' }
      }
    }
    return result
  } catch {
    return result
  } finally {
    await loc
      .evaluate((target, attr) => {
        target.ownerDocument
          .querySelector(`[${attr}]`)
          ?.removeAttribute(attr)
      }, DROPDOWN_ATTR)
      .catch(() => {})
  }
}

async function pointHitsLocator(
  loc: Locator,
  x: number,
  y: number,
): Promise<boolean> {
  return loc
    .evaluate(
      (el, coords) => {
        let top = document.elementFromPoint(coords.x, coords.y)
        if (!top) return false
        // Match Cursor's deep hit test for controls inside open shadow roots.
        while ((top as HTMLElement).shadowRoot) {
          const inner = (top as HTMLElement).shadowRoot!.elementFromPoint(
            coords.x,
            coords.y,
          )
          if (!inner || inner === top) break
          top = inner
        }
        let current: Node | null = top
        while (current) {
          if (current === el) return true
          const root = current.getRootNode()
          current =
            current.parentNode ??
            (root instanceof ShadowRoot ? root.host : null)
        }
        return false
      },
      { x, y },
    )
    .catch(() => false)
}

export interface ClickIntercept {
  blockingType: string
  interceptedBy: string
  interceptedRef?: string
  error: string
  suggestion: string
}

export function formatClickIntercept(hit: ClickIntercept): string {
  const lines = [hit.error, hit.suggestion]
  if (hit.interceptedRef) {
    lines.push(
      `Intercepted by: ${hit.interceptedBy} [ref=${hit.interceptedRef}]`,
    )
    lines.push(
      `Recovery action: browser_click with ref "${hit.interceptedRef}" if that is the overlay, or browser_snapshot`,
    )
  } else {
    lines.push(`Intercepted by: ${hit.interceptedBy}`)
    lines.push('Recovery action: browser_snapshot')
  }
  return lines.join('\n')
}

export async function diagnoseClickIntercept(
  page: Page,
  loc: Locator,
  x: number,
  y: number,
): Promise<ClickIntercept | undefined> {
  const intercept = await loc
    .evaluate(
      (target, coords) => {
        const hit = document.elementFromPoint(
          coords.x,
          coords.y,
        ) as HTMLElement | null
        if (!hit) {
          return {
            blockingType: 'outside-viewport',
            interceptedBy: 'nothing (coordinates outside viewport)',
            error: 'Click coordinates are outside the visible viewport.',
            suggestion: 'Scroll the target into view, then snapshot and retry.',
          }
        }
        if (target === hit || target.contains(hit)) return null

        let current: HTMLElement | null = hit
        while (current && current !== target && current !== document.body) {
          const tag = current.tagName?.toLowerCase() || ''
          const role = current.getAttribute?.('role') || ''
          const style = window.getComputedStyle(current)
          const zIndex = parseInt(style.zIndex, 10)
          const hasHighZ = !Number.isNaN(zIndex) && zIndex > 100
          const isFixed =
            style.position === 'fixed' || style.position === 'absolute'
          const hitRef =
            current.getAttribute('aria-ref') ||
            current.getAttribute('data-cursor-ref') ||
            undefined
          const name = (
            current.getAttribute('aria-label') ||
            current.textContent ||
            ''
          )
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 60)
          const interceptedBy = role
            ? `${tag} role=${role}${name ? ` "${name}"` : ''}`
            : `${tag}${name ? ` "${name}"` : ''}`

          if (tag === 'iframe') {
            return {
              blockingType: 'iframe',
              interceptedBy,
              interceptedRef: hitRef,
              error: 'Click would hit an iframe instead of the target element.',
              suggestion:
                'Snapshot again — iframe controls use refs like f1e5. Click the inner control, not the iframe chrome.',
            }
          }
          const className =
            typeof current.className === 'string' ? current.className : ''
          if (
            tag === 'dialog' ||
            role === 'dialog' ||
            role === 'alertdialog' ||
            current.getAttribute('aria-modal') === 'true' ||
            /\b(x-window|x-message-box)\b/.test(className)
          ) {
            return {
              blockingType: 'modal',
              interceptedBy,
              interceptedRef: hitRef,
              error:
                'Click would hit a modal/dialog instead of the target element.',
              suggestion:
                'Answer the dialog by clicking one of its own buttons (read its text first: on "unsaved changes" prompts, No/Cancel may discard the form or leave the page). Do not press Escape — some apps treat it as "cancel edit". Then snapshot and retry the original control.',
            }
          }
          if (
            (tag === 'nav' ||
              tag === 'header' ||
              role === 'navigation' ||
              role === 'banner') &&
            isFixed
          ) {
            return {
              blockingType: 'fixed-header',
              interceptedBy,
              interceptedRef: hitRef,
              error:
                'Click would hit a fixed header/navigation bar instead of the target.',
              suggestion:
                'Scroll so the target is not behind the header, or click the header control if that was the intent.',
            }
          }
          if (hasHighZ && isFixed) {
            return {
              blockingType: 'overlay',
              interceptedBy,
              interceptedRef: hitRef,
              error:
                'Click would hit an overlay instead of the target element.',
              suggestion:
                'Snapshot to see what the overlay is. If it is a dialog or message box, click one of its buttons; if it is a dropdown, pick an option or click the field it belongs to. Do not press Escape — some apps treat it as "cancel edit".',
            }
          }
          current = current.parentElement
        }

        const otherRef =
          hit.getAttribute('aria-ref') ||
          hit.getAttribute('data-cursor-ref') ||
          undefined
        const otherName = (
          hit.getAttribute('aria-label') ||
          hit.textContent ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 60)
        const otherTag = hit.tagName?.toLowerCase() || 'element'
        const otherRole = hit.getAttribute('role') || ''
        return {
          blockingType: 'other',
          interceptedBy: otherRole
            ? `${otherTag} role=${otherRole}${otherName ? ` "${otherName}"` : ''}`
            : `${otherTag}${otherName ? ` "${otherName}"` : ''}`,
          interceptedRef: otherRef,
          error: 'Click would hit a different element than the target.',
          suggestion:
            'Snapshot to see what is covering the control, then click that overlay or a new ref.',
        }
      },
      { x, y },
    )
    .catch(() => undefined)
  return intercept ?? undefined
}

export async function resolveClickTarget(
  page: Page,
  targetId: string,
  ref: string,
  element?: string,
  opts?: {
    retryOnStaleRef?: boolean
    refreshSnapshot?: () => Promise<void>
  },
): Promise<{ loc: Locator; ref: string; described: DescribedElement }> {
  const normalized = normalizeRef(ref)
  const retry = opts?.retryOnStaleRef !== false
  const knownBefore = getRefMeta(targetId, normalized)
  const hint =
    element?.trim() ||
    (knownBefore?.name
      ? `${knownBefore.role} "${knownBefore.name}"`
      : undefined)

  const tryRef = async (candidate: string) => {
    const loc = await targetLocator(page, { ref: candidate })
    const described = await describeElement(loc, candidate)
    assertElementHint(described, element, candidate)
    return { loc, ref: candidate, described }
  }

  try {
    return await tryRef(normalized)
  } catch (err) {
    if (!(err instanceof StaleRefError) || !retry) throw err
    if (opts?.refreshSnapshot) await opts.refreshSnapshot()
    try {
      return await tryRef(normalized)
    } catch (err2) {
      if (!(err2 instanceof StaleRefError)) throw err2
    }
    const recovered = recoverRefByHint(
      targetId,
      normalized,
      hint,
      knownBefore?.role,
    )
    if (!recovered || recovered === normalized) throw err
    return tryRef(recovered)
  }
}

export interface RobustClickOpts {
  button?: 'left' | 'right' | 'middle'
  doubleClick?: boolean
  modifiers?: Array<'Alt' | 'Control' | 'Meta' | 'Shift'>
  offsetX?: number
  offsetY?: number
  force?: boolean
  maxScrollAttempts?: number
  retryOnStaleRef?: boolean
  autoCloseDropdowns?: boolean
  retryWithOffset?: boolean
}

export async function clickLocatorRobust(
  page: Page,
  loc: Locator,
  opts: RobustClickOpts,
): Promise<void> {
  const maxScroll = opts.maxScrollAttempts ?? DEFAULT_MAX_SCROLL_ATTEMPTS
  const attempted: string[] = [
    `scrolled into view (up to ${maxScroll} attempts)`,
  ]
  await ensureInView(loc, page, maxScroll)

  const box = await loc.boundingBox()
  if (!box) {
    throw new StaleRefError(
      'Element has no bounding box. Capture a new snapshot and retry.',
    )
  }
  const viewport = await pageViewport(page)
  if (!isBoxInViewport(box, viewport)) {
    throw new BrowserError(
      `Element is outside the visible viewport ` +
        `(box x=${Math.round(box.x)}, y=${Math.round(box.y)}, ` +
        `width=${Math.round(box.width)}, height=${Math.round(box.height)}; ` +
        `viewport ${viewport.width}x${viewport.height}). Capture a new snapshot; ` +
        `do not force-click this ref.`,
    )
  }

  const preferredPosition = {
    x: opts.offsetX ?? box.width / 2,
    y: opts.offsetY ?? box.height / 2,
  }
  const position = visibleClickPosition(box, viewport, preferredPosition)
  const viewportX = box.x + position.x
  const viewportY = box.y + position.y

  const clickArgs = {
    timeout: 8_000,
    button: opts.button,
    modifiers: opts.modifiers,
    force: opts.force,
    position,
  }

  const performClick = async () => {
    if (opts.doubleClick) await loc.dblclick(clickArgs)
    else await loc.click(clickArgs)
  }

  if (opts.force) {
    await performClick()
    return
  }

  if (await pointHitsLocator(loc, viewportX, viewportY)) {
    await performClick()
    return
  }

  if (opts.autoCloseDropdowns !== false) {
    const dismissal = await dismissBlockingDropdown(loc, position)
    if (dismissal.detected) {
      const which = dismissal.dropdown ? ` (${dismissal.dropdown})` : ''
      attempted.push(
        dismissal.closed
          ? `closed the covering dropdown${which} via ${dismissal.method}`
          : `the covering dropdown${which} did not close`,
      )
      if (
        dismissal.closed &&
        (await pointHitsLocator(loc, viewportX, viewportY))
      ) {
        await performClick()
        return
      }
    }
  }

  if (opts.retryWithOffset !== false) {
    attempted.push('offset click retries')
    const offsets = [
      { x: box.width * 0.25, y: box.height * 0.5 },
      { x: box.width * 0.75, y: box.height * 0.5 },
      { x: box.width * 0.5, y: box.height * 0.25 },
      { x: box.width * 0.5, y: box.height * 0.75 },
    ]
    for (const off of offsets) {
      const ox = box.x + off.x
      const oy = box.y + off.y
      if (!(await pointHitsLocator(loc, ox, oy))) continue
      const retryArgs = { ...clickArgs, position: off }
      if (opts.doubleClick) await loc.dblclick(retryArgs)
      else await loc.click(retryArgs)
      return
    }
  }

  const intercept = await diagnoseClickIntercept(
    page,
    loc,
    viewportX,
    viewportY,
  )
  if (intercept) {
    throw new BrowserError(
      `Already tried: ${attempted.join('; ')}.\n${formatClickIntercept(intercept)}`,
    )
  }
  await performClick()
}
