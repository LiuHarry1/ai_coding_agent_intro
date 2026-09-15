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
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await loc.scrollIntoViewIfNeeded({ timeout: 2_000 })
      const box = await loc.boundingBox()
      if (box && box.width > 0 && box.height > 0) return
    } catch {
      /* scroll and retry */
    }
    await page.mouse.wheel(0, 300)
    await page.waitForTimeout(100)
  }
}

export async function dismissOpenDropdowns(page: Page): Promise<void> {
  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(50)
  await page.mouse.click(8, 8).catch(() => {})
  await page.waitForTimeout(50)
}

async function pointHitsLocator(
  loc: Locator,
  x: number,
  y: number,
): Promise<boolean> {
  return loc
    .evaluate(
      (el, coords) => {
        const top = document.elementFromPoint(coords.x, coords.y)
        if (!top) return false
        return el === top || el.contains(top)
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
        const hit = document.elementFromPoint(coords.x, coords.y) as
          | HTMLElement
          | null
        if (!hit) {
          return {
            blockingType: 'outside-viewport',
            interceptedBy: 'nothing (coordinates outside viewport)',
            error: 'Click coordinates are outside the visible viewport.',
            suggestion:
              'Scroll the target into view, then snapshot and retry.',
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
            (current.textContent || '')
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
              error:
                'Click would hit an iframe instead of the target element.',
              suggestion:
                'Snapshot again — iframe controls use refs like f1e5. Click the inner control, not the iframe chrome.',
            }
          }
          if (
            tag === 'dialog' ||
            role === 'dialog' ||
            role === 'alertdialog' ||
            current.getAttribute('aria-modal') === 'true'
          ) {
            return {
              blockingType: 'modal',
              interceptedBy,
              interceptedRef: hitRef,
              error:
                'Click would hit a modal/dialog instead of the target element.',
              suggestion:
                'Close the modal first by clicking its close button, then snapshot and retry the original control.',
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
              error: 'Click would hit an overlay instead of the target element.',
              suggestion:
                'Dismiss the overlay (Escape or its close control), then snapshot and retry.',
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
          (hit.textContent || '')
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
  const attempted: string[] = [`scrolled into view (up to ${maxScroll} attempts)`]
  await ensureInView(loc, page, maxScroll)

  const box = await loc.boundingBox()
  if (!box) {
    throw new StaleRefError(
      'Element has no bounding box. Capture a new snapshot and retry.',
    )
  }

  const position = {
    x: opts.offsetX ?? box.width / 2,
    y: opts.offsetY ?? box.height / 2,
  }
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
    attempted.push('dismissed open dropdowns')
    await dismissOpenDropdowns(page)
    if (await pointHitsLocator(loc, viewportX, viewportY)) {
      await performClick()
      return
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
