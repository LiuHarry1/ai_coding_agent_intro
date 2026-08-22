/**
 * Cursor-style click prep: scroll into view, stale-ref recovery, dropdown dismiss,
 * and offset retry when a non-interactive layer blocks the target.
 */

import type { Locator, Page } from 'playwright-core'
import {
  elementMatchesHint,
  parseRefMeta,
  type RefMeta,
} from '../snapshot-index.js'
import { getLastSnapshot, getRefMeta } from '../session-flags.js'
import { StaleRefError, type ResolvedElement } from '../types.js'
import {
  assertElementHint,
  describeElement,
  normalizeRef,
  targetLocator,
} from './locator.js'

export const DEFAULT_MAX_SCROLL_ATTEMPTS = 5

export function recoverRefByHint(
  targetId: string,
  ref: string,
  elementHint?: string,
): string | undefined {
  const hint = elementHint?.trim()
  if (!hint) return undefined

  const yaml = getLastSnapshot(targetId)
  if (!yaml) return undefined

  const candidates = parseRefMeta(yaml)
  const prefer = (list: RefMeta[]) =>
    list.find(c => c.ref !== ref && elementMatchesHint(c, hint))?.ref

  if (known?.role) {
    const sameRole = candidates.filter(
      c => c.ref !== ref && c.role === known.role,
    )
    const hit = prefer(sameRole)
    if (hit) return hit
  }

  return prefer(candidates)
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

export async function resolveClickTarget(
  page: Page,
  targetId: string,
  ref: string,
  element?: string,
): Promise<{ loc: Locator; ref: string; described: ResolvedElement }> {
  const normalized = normalizeRef(ref)
  const tryRef = async (candidate: string) => {
    const loc = await targetLocator(page, { ref: candidate, element })
    const described = await describeElement(loc, candidate)
    assertElementHint(described, element, candidate)
    return { loc, ref: candidate, described }
  }

  try {
    return await tryRef(normalized)
  } catch (err) {
    if (!(err instanceof StaleRefError) || !element?.trim()) throw err
    const known = getRefMeta(targetId, normalized)
    if (!known || !elementMatchesHint(known, element)) throw err
    const recovered = recoverRefByHint(targetId, normalized, element)
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

  if (await pointHitsLocator(loc, viewportX, viewportY)) {
    await performClick()
    return
  }

  if (opts.autoCloseDropdowns !== false) {
    await dismissOpenDropdowns(page)
    if (await pointHitsLocator(loc, viewportX, viewportY)) {
      await performClick()
      return
    }
  }

  if (opts.retryWithOffset !== false) {
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

  await performClick()
}
