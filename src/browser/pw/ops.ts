/**
 * OpenClaw-style Playwright operations: AI aria snapshot + aria-ref locators.
 *
 * Snapshot: `page.ariaSnapshot({ mode: 'ai' })` — Playwright's own tree, with
 * `eN` refs stamped on the live DOM.
 * Click/type: `page.locator('aria-ref=eN')` — Playwright's actionability
 * checks and trusted input, not our injected distiller.
 */

import type { Locator, Page, Request } from 'playwright-core'
import {
  BrowserError,
  StaleRefError,
  type BrowserBackend,
} from '../types.js'
import type { ResolvedRef, SnapshotOpts, SnapshotResult } from '../page-ops.js'
import { prioritizeAriaSnapshot } from './prioritize-snapshot.js'
import { getPageForTarget } from './session.js'

const ACTION_TIMEOUT_MS = 8_000
const SNAPSHOT_TIMEOUT_MS = 8_000
/** Playwright MCP waits ~500ms after an action so late XHR/DOM can land. */
const ACTION_SETTLE_MS = 500
const NETWORK_DRAIN_MS = 3_000
const WAIT_FOR_TIMEOUT_MS = 15_000
const WAIT_FOR_TIME_CAP_S = 10

function isTrackedRequest(req: Request): boolean {
  const type = req.resourceType()
  return type === 'xhr' || type === 'fetch'
}

/**
 * Playwright MCP's waitForNetwork: listen for XHR/fetch started by the
 * action, wait a short settle, then drain those requests. Does not wait
 * for an ARIA dialog to look "rich".
 */
async function withActionWait<T>(
  page: Page,
  action: () => Promise<T>,
): Promise<T> {
  const pending = new Set<Request>()
  const onRequest = (req: Request) => {
    if (isTrackedRequest(req)) pending.add(req)
  }
  const onDone = (req: Request) => {
    pending.delete(req)
  }
  page.on('request', onRequest)
  page.on('requestfinished', onDone)
  page.on('requestfailed', onDone)
  try {
    const result = await action()
    await new Promise<void>(r => setTimeout(r, ACTION_SETTLE_MS))
    const deadline = Date.now() + NETWORK_DRAIN_MS
    while (pending.size > 0 && Date.now() < deadline) {
      await new Promise<void>(r => setTimeout(r, 50))
    }
    return result
  } finally {
    page.off('request', onRequest)
    page.off('requestfinished', onDone)
    page.off('requestfailed', onDone)
  }
}

export function normalizeRef(ref: string): string {
  const trimmed = ref.trim()
  if (trimmed.startsWith('@')) return trimmed.slice(1)
  if (trimmed.startsWith('ref=')) return trimmed.slice(4)
  return trimmed
}

function refLocator(page: Page, ref: string): Locator {
  return page.locator(`aria-ref=${normalizeRef(ref)}`)
}

function mapPlaywrightError(err: unknown, ref?: string): never {
  const message = err instanceof Error ? err.message : String(err)
  if (
    /Timeout|strict mode violation|waiting for locator|No node found for selector/i.test(
      message,
    )
  ) {
    throw new StaleRefError(
      ref
        ? `No element for ref ${ref}. The page changed; take a fresh snapshot.`
        : `Playwright could not find the target. Take a fresh snapshot.`,
    )
  }
  throw new BrowserError(message)
}

async function describeLocator(
  loc: Locator,
  ref: string,
): Promise<ResolvedRef> {
  const box = await loc.boundingBox().catch(() => null)
  const info = await loc
    .evaluate(el => {
      const role =
        el.getAttribute('role') ||
        (el instanceof HTMLInputElement
          ? el.type === 'submit' || el.type === 'button'
            ? 'button'
            : 'textbox'
          : el.tagName.toLowerCase())
      const name = (
        el.getAttribute('aria-label') ||
        (el instanceof HTMLInputElement ? el.placeholder : '') ||
        (el.textContent || '').replace(/\s+/g, ' ').trim()
      ).slice(0, 120)
      const tag = el.tagName.toLowerCase()
      const isEditable =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el as HTMLElement).isContentEditable
      return { role, name, tag, isEditable }
    })
    .catch(() => ({
      role: 'generic',
      name: ref,
      tag: 'div',
      isEditable: false,
    }))

  const x = box ? box.x + box.width / 2 : 0
  const y = box ? box.y + box.height / 2 : 0
  return {
    ok: true,
    ref,
    role: info.role,
    name: info.name,
    x,
    y,
    pageX: x,
    pageY: y,
    width: box?.width ?? 0,
    height: box?.height ?? 0,
    tag: info.tag,
    isEditable: info.isEditable,
  }
}

function fallbackRef(ref: string): ResolvedRef {
  return {
    ok: true,
    ref,
    role: 'generic',
    name: ref,
    x: 0,
    y: 0,
    pageX: 0,
    pageY: 0,
    width: 0,
    height: 0,
    tag: 'div',
    isEditable: false,
  }
}

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
    const refs = yaml.match(/\[ref=/g)?.length ?? 0
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
    const timeout = SNAPSHOT_TIMEOUT_MS
    // compact on a subtree must not pass depth: Playwright's depth clip is what
    // turned an open dialog into Close + title. Full-page compact may still
    // cap depth; selector-scoped snapshots keep the full subtree.
    const depth =
      opts.compact && !opts.selector ? 16 : undefined
    const raw = opts.selector
      ? await richestLocatorSnapshot(page, opts.selector, timeout)
      : await page.ariaSnapshot({
          mode: 'ai',
          timeout,
          ...(depth !== undefined ? { depth } : {}),
        })
    const maxChars = opts.maxChars ?? 20_000
    const { text, truncated } = prioritizeAriaSnapshot(raw, maxChars)
    return {
      url: page.url(),
      title: await page.title().catch(() => ''),
      text,
      nodes: (text.match(/\[ref=/g) ?? []).length,
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
      /Timeout/i.test(message)
        ? `Timed out waiting for ${what}.`
        : message,
    )
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
): Promise<ResolvedRef> {
  const page = await getPageForTarget(backend, targetId)
  const loc = refLocator(page, opts.ref)
  const modifiers = opts.modifiers as
    | Array<'Alt' | 'Control' | 'Meta' | 'Shift'>
    | undefined
  try {
    await page.bringToFront().catch(() => {})
    await withActionWait(page, async () => {
      if (opts.doubleClick) {
        await loc.dblclick({
          timeout: ACTION_TIMEOUT_MS,
          button: opts.button,
          modifiers,
        })
      } else {
        await loc.click({
          timeout: ACTION_TIMEOUT_MS,
          button: opts.button,
          modifiers,
        })
      }
    })
    return await describeLocator(loc, opts.ref).catch(() =>
      fallbackRef(opts.ref),
    )
  } catch (err) {
    mapPlaywrightError(err, opts.ref)
  }
}

export async function hover(
  backend: BrowserBackend,
  targetId: string,
  opts: { ref: string },
): Promise<ResolvedRef> {
  const page = await getPageForTarget(backend, targetId)
  const loc = refLocator(page, opts.ref)
  try {
    await page.bringToFront().catch(() => {})
    await loc.hover({ timeout: ACTION_TIMEOUT_MS })
    return await describeLocator(loc, opts.ref)
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
): Promise<ResolvedRef> {
  const page = await getPageForTarget(backend, targetId)
  const loc = refLocator(page, opts.ref)
  try {
    await page.bringToFront().catch(() => {})
    await withActionWait(page, async () => {
      await loc.click({ timeout: ACTION_TIMEOUT_MS })
      if (opts.slowly) {
        await loc.pressSequentially(opts.text, { timeout: ACTION_TIMEOUT_MS })
      } else {
        await page.keyboard.insertText(opts.text)
      }
      if (opts.submit) await page.keyboard.press('Enter')
    })
    return await describeLocator(loc, opts.ref)
  } catch (err) {
    mapPlaywrightError(err, opts.ref)
  }
}

export async function fillField(
  backend: BrowserBackend,
  targetId: string,
  ref: string,
  value: string,
): Promise<{ role: string; name: string }> {
  const page = await getPageForTarget(backend, targetId)
  const loc = refLocator(page, ref)
  try {
    await loc.fill(value, { timeout: ACTION_TIMEOUT_MS })
    const el = await describeLocator(loc, ref)
    return { role: el.role, name: el.name }
  } catch (err) {
    mapPlaywrightError(err, ref)
  }
}

export async function selectOption(
  backend: BrowserBackend,
  targetId: string,
  ref: string,
  values: string[],
): Promise<{ selected: string[] }> {
  const page = await getPageForTarget(backend, targetId)
  try {
    const selected = await refLocator(page, ref).selectOption(values, {
      timeout: ACTION_TIMEOUT_MS,
    })
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
    if (opts.ref) {
      const loc = refLocator(page, opts.ref)
      await loc.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS })
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
      return
    }
    await page.mouse.wheel(deltaX, deltaY)
  } catch (err) {
    mapPlaywrightError(err, opts.ref)
  }
}

export async function navigate(
  backend: BrowserBackend,
  targetId: string,
  url: string,
): Promise<void> {
  const page = await getPageForTarget(backend, targetId)
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    // SPAs paint chrome before the main tree; give widgets a beat to mount.
    await new Promise(r => setTimeout(r, 800))
  } catch (err) {
    mapPlaywrightError(err)
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
): Promise<{ buffer: Buffer; format: 'png' | 'jpeg'; element?: ResolvedRef }> {
  const page = await getPageForTarget(backend, targetId)
  const format = opts.format ?? 'png'
  try {
    if (opts.ref) {
      const loc = refLocator(page, opts.ref)
      const element = await describeLocator(loc, opts.ref)
      const buffer = Buffer.from(
        await loc.screenshot({
          type: format,
          timeout: ACTION_TIMEOUT_MS,
          ...(format === 'jpeg' ? { quality: opts.quality ?? 80 } : {}),
        }),
      )
      return { buffer, format, element }
    }
    const buffer = Buffer.from(
      await page.screenshot({
        type: format,
        fullPage: opts.fullPage,
        timeout: ACTION_TIMEOUT_MS,
        ...(format === 'jpeg' ? { quality: opts.quality ?? 80 } : {}),
      }),
    )
    return { buffer, format }
  } catch (err) {
    mapPlaywrightError(err, opts.ref)
  }
}
