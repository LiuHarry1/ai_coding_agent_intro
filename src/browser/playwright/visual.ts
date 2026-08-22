/**
 * Visual grounding helpers (Cursor-style highlight + bounding box).
 */

import type { BrowserBackend } from '../types.js'
import { ACTION_TIMEOUT_MS } from '../limits.js'
import {
  assertElementHint,
  describeElement,
  mapPlaywrightError,
  targetLocator,
} from './locator.js'
import { ensureInView } from './robust-click.js'
import { getPageForTarget } from './connect.js'

export async function highlightElement(
  backend: BrowserBackend,
  targetId: string,
  opts: { ref: string; element?: string; durationMs?: number },
): Promise<{ role: string; name: string }> {
  const page = await getPageForTarget(backend, targetId)
  const duration = opts.durationMs ?? 2_000
  try {
    await page.bringToFront().catch(() => {})
    const loc = await targetLocator(page, {
      ref: opts.ref,
      element: opts.element,
    })
    const described = await describeElement(loc, opts.ref)
    assertElementHint(described, opts.element, opts.ref)
    await ensureInView(loc, page)
    await loc.evaluate(
      (el, ms) => {
        const node = el as HTMLElement
        const prev = node.style.outline
        const prevOffset = node.style.outlineOffset
        node.style.outline = '3px solid #f59e0b'
        node.style.outlineOffset = '2px'
        window.setTimeout(() => {
          node.style.outline = prev
          node.style.outlineOffset = prevOffset
        }, ms)
      },
      duration,
    )
    return { role: described.role, name: described.name }
  } catch (err) {
    mapPlaywrightError(err, opts.ref)
  }
}

export async function getElementBoundingBox(
  backend: BrowserBackend,
  targetId: string,
  opts: { ref: string; element?: string },
): Promise<{ x: number; y: number; width: number; height: number }> {
  const page = await getPageForTarget(backend, targetId)
  try {
    await page.bringToFront().catch(() => {})
    const loc = await targetLocator(page, {
      ref: opts.ref,
      element: opts.element,
    })
    const described = await describeElement(loc, opts.ref)
    assertElementHint(described, opts.element, opts.ref)
    await ensureInView(loc, page)
    const box = await loc.boundingBox({ timeout: ACTION_TIMEOUT_MS })
    if (!box) {
      throw new Error(
        `Ref ${opts.ref} has no bounding box. Capture a new snapshot.`,
      )
    }
    return box
  } catch (err) {
    mapPlaywrightError(err, opts.ref)
  }
}
