/** Overlay snapshot refs on a screenshot and return their boxes. */
import type { Page } from 'playwright-core'
import {
  ANNOTATION_MAX_LABELS_DEFAULT,
  type AnnotationItem,
  buildOverlayClearScript,
  buildOverlayInjectionScript,
  type CoordinateSpace,
  planAnnotations,
  type RawAnnotationInput,
} from '../screenshot-annotate.js'
import type { BrowserBackend } from '../types.js'
import { listRefMeta } from '../session-flags.js'
import { ACTION_TIMEOUT_MS } from '../limits.js'
import { getPageForTarget } from './connect.js'
import { refLocator } from './locator.js'

export async function screenshotWithLabels(
  backend: BrowserBackend,
  targetId: string,
  opts: {
    maxLabels?: number
    type?: 'png' | 'jpeg'
    timeoutMs?: number
    fullPage?: boolean
    ref?: string
  } = {},
): Promise<{
  buffer: Buffer
  labels: number
  skipped: number
  annotations: AnnotationItem[]
}> {
  const page = await getPageForTarget(backend, targetId)
  const type = opts.type ?? 'png'
  const maxLabels =
    typeof opts.maxLabels === 'number' && Number.isFinite(opts.maxLabels)
      ? Math.max(1, Math.floor(opts.maxLabels))
      : ANNOTATION_MAX_LABELS_DEFAULT

  const refKey = opts.ref?.trim() || undefined
  const space: CoordinateSpace = opts.fullPage
    ? 'fullpage'
    : refKey
      ? 'element'
      : 'viewport'

  const view = await page.evaluate(() => ({
    x: window.scrollX || 0,
    y: window.scrollY || 0,
    width: window.innerWidth || 0,
    height: window.innerHeight || 0,
  }))
  const scroll = { x: view.x, y: view.y }

  let elementRect:
    | { x: number; y: number; width: number; height: number }
    | undefined
  if (space === 'element') {
    const box = await resolveElementBoundingBoxForLabels(page, refKey)
    if (!box) {
      throw new Error(
        `screenshotWithLabelsViaPlaywright: element not found for ref="${refKey}"`,
      )
    }
    elementRect = {
      x: box.x + scroll.x,
      y: box.y + scroll.y,
      width: box.width,
      height: box.height,
    }
  }

  const refs = listRefMeta(targetId)
  const refKeys = Object.keys(refs)
  const inputs: RawAnnotationInput[] = []
  let bboxFailures = 0
  for (const ref of refKeys) {
    const refInfo = refs[ref]
    if (refInfo === undefined) continue
    const box = await refLocator(page, ref)
      .boundingBox()
      .catch(() => null)
    if (!box) {
      bboxFailures += 1
      continue
    }
    inputs.push({
      ref,
      role: refInfo.role,
      name: refInfo.name,
      doc: {
        x: box.x + scroll.x,
        y: box.y + scroll.y,
        width: box.width,
        height: box.height,
      },
    })
  }

  const plan = planAnnotations({
    inputs,
    space,
    scroll,
    viewport: { width: view.width, height: view.height },
    elementRect,
    maxLabels,
  })

  const timeoutMs = opts.timeoutMs ?? ACTION_TIMEOUT_MS
  try {
    if (plan.overlayItems.length > 0) {
      const captureY =
        space === 'element'
          ? elementRect?.y
          : space === 'viewport'
            ? scroll.y
            : 0
      await page.evaluate(
        buildOverlayInjectionScript({ items: plan.overlayItems, captureY }),
      )
    }
    const buffer =
      space === 'element'
        ? await captureElementScreenshotForLabels(page, refKey, type, timeoutMs)
        : await page.screenshot({
            type,
            fullPage: Boolean(opts.fullPage),
            timeout: timeoutMs,
          })
    return {
      buffer: Buffer.from(buffer),
      labels: plan.overlayItems.length,
      skipped: plan.skipped + bboxFailures,
      annotations: plan.annotations,
    }
  } finally {
    await page.evaluate(buildOverlayClearScript()).catch(() => {})
  }
}

async function resolveElementBoundingBoxForLabels(
  page: Page,
  refKey: string | undefined,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  if (!refKey) return null
  try {
    return await refLocator(page, refKey).boundingBox()
  } catch {
    return null
  }
}

async function captureElementScreenshotForLabels(
  page: Page,
  refKey: string | undefined,
  type: 'png' | 'jpeg',
  timeoutMs: number | undefined,
): Promise<Buffer> {
  if (!refKey) {
    throw new Error('captureElementScreenshotForLabels: requires refKey')
  }
  return await refLocator(page, refKey).screenshot({
    type,
    timeout: timeoutMs,
  })
}
