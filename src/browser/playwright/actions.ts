/**
 * Acting on a ref: `page.locator('aria-ref=eN')` plus Playwright's actionability
 * checks and trusted input.
 *
 * Elements are described *before* the action, not after. A button that says
 * "Clicked 0 times" says "Clicked 1 times" once you press it, and reporting the
 * after-state names something the model never chose — worse, an action that
 * navigates away leaves nothing to describe at all.
 */

import type { Frame, Locator, Page } from 'playwright-core'
import { ensureScript } from '../page-inspect.js'
import {
  ACTION_TIMEOUT_MS,
  NAVIGATE_NETWORK_DRAIN_MS,
  NAVIGATE_SETTLE_MS,
  NAVIGATE_TIMEOUT_MS,
} from '../limits.js'
import { BrowserError, StaleRefError, type BrowserBackend, type ResolvedElement } from '../types.js'
import {
  describeElement,
  mapPlaywrightError,
  refLocator,
} from './locator.js'
import { pickValue } from './pick.js'
import { handleDialog, peekDialog, throwIfUnarmedDestructiveDialog, uploadFiles } from './overlays.js'
import { drainTrackedRequests, settleIfUrlChanged, withActionWait } from './settle.js'
import { getPageForTarget } from './connect.js'
import { isSnapshotDegraded, getRefMeta, clearTabMemory } from '../session-flags.js'
import { assertNavigateUrl } from '../navigate-policy.js'
import { elementMatchesHint, namesOverlap } from '../snapshot-index.js'
import { isHeavyMediaFrame, SNAPSHOT_STALL_NEXT } from '../heavy-media.js'

export async function navigate(
  backend: BrowserBackend,
  targetId: string,
  dest: { url?: string; action?: 'back' | 'forward' | 'reload' },
): Promise<void> {
  await ensureScript(backend, targetId)
  const page = await getPageForTarget(backend, targetId)
  try {
    await withActionWait(page, async () => {
      if (dest.action === 'back') {
        await page.goBack({
          waitUntil: 'domcontentloaded',
          timeout: NAVIGATE_TIMEOUT_MS,
        })
        return
      }
      if (dest.action === 'forward') {
        await page.goForward({
          waitUntil: 'domcontentloaded',
          timeout: NAVIGATE_TIMEOUT_MS,
        })
        return
      }
      if (dest.action === 'reload') {
        await page.reload({
          waitUntil: 'domcontentloaded',
          timeout: NAVIGATE_TIMEOUT_MS,
        })
        return
      }
      if (!dest.url) {
        throw new BrowserError('navigate requires a url, or action back/forward/reload.')
      }
      const href = assertNavigateUrl(dest.url)
      await page.goto(href, {
        waitUntil: 'domcontentloaded',
        timeout: NAVIGATE_TIMEOUT_MS,
      })
    })
    clearTabMemory(targetId)
    await new Promise(r => setTimeout(r, NAVIGATE_SETTLE_MS))
    await drainTrackedRequests(page, NAVIGATE_NETWORK_DRAIN_MS)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/Timeout/i.test(message)) {
      throw new BrowserError(
        `Navigation timed out. Stay on this tab — do not retry navigate. ${SNAPSHOT_STALL_NEXT}`,
      )
    }
    mapPlaywrightError(err)
  }
}

/** Make this tab the visible one and give a SPA a beat to refetch. */
export async function activateTab(
  backend: BrowserBackend,
  targetId: string,
): Promise<void> {
  const page = await getPageForTarget(backend, targetId)
  await page.bringToFront().catch(() => {})
  await new Promise(r => setTimeout(r, NAVIGATE_SETTLE_MS))
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Playwright MCP compiles clicks to `page.getByRole(role, { name }).click()`
 * when it has a snapshot. After a stalled snapshot we skip the ref and use
 * the same locator API.
 */
async function locateByRoleName(
  page: Page,
  role: string,
  name: string,
): Promise<Locator> {
  const frames: Frame[] = []
  const seen = new Set<Frame>()
  const consider = (frame: Frame) => {
    if (seen.has(frame) || isHeavyMediaFrame(frame.url())) return
    seen.add(frame)
    frames.push(frame)
  }
  consider(page.mainFrame())
  for (const frame of page.frames()) consider(frame)

  const pattern = new RegExp(`^${escapeRegExp(name)}$`, 'i')
  for (const frame of frames) {
    const loc = frame.getByRole(
      role as Parameters<Frame['getByRole']>[0],
      { name: pattern },
    )
    const count = await loc.count().catch(() => 0)
    const visible: Locator[] = []
    for (let i = 0; i < count; i++) {
      const item = loc.nth(i)
      if (await item.isVisible().catch(() => false)) visible.push(item)
    }
    if (visible.length === 1) return visible[0]
    if (visible.length > 1) {
      throw new BrowserError(
        `Multiple visible ${role} named ${JSON.stringify(name)}. Take a snapshot and click the ref.`,
      )
    }
  }
  throw new BrowserError(
    `No visible ${role} named ${JSON.stringify(name)}. Take a snapshot, or pass a ref from the last tree.`,
  )
}

function assertClickSemantics(
  described: { role: string; name: string },
  expected?: { role: string; name: string },
  elementHint?: string,
): void {
  if (elementHint && !elementMatchesHint(described, elementHint)) {
    throw new StaleRefError(
      `Stale element reference: expected ${JSON.stringify(elementHint)} but found ${described.role} "${described.name}". The page may have changed. Take a new snapshot.`,
    )
  }
  if (expected?.name && described.name && !namesOverlap(described.name, expected.name)) {
    throw new StaleRefError(
      `Ref now points at ${described.role} "${described.name}" (was "${expected.name}"). Take a fresh snapshot.`,
    )
  }
}

export async function click(
  backend: BrowserBackend,
  targetId: string,
  opts: {
    ref?: string
    role?: string
    name?: string
    element?: string
    button?: 'left' | 'right' | 'middle'
    doubleClick?: boolean
    modifiers?: string[]
    x?: number
    y?: number
    force?: boolean
  },
): Promise<ResolvedElement> {
  const page = await getPageForTarget(backend, targetId)
  const modifiers = opts.modifiers as
    | Array<'Alt' | 'Control' | 'Meta' | 'Shift'>
    | undefined
  try {
    await page.bringToFront().catch(() => {})
    if (opts.x != null && opts.y != null && !opts.ref) {
      const urlBefore = page.url()
      await withActionWait(page, async () => {
        await page.mouse.click(opts.x!, opts.y!, {
          button: opts.button,
          clickCount: opts.doubleClick ? 2 : 1,
        })
      })
      throwIfUnarmedDestructiveDialog(page)
      await settleIfUrlChanged(page, urlBefore)
      return {
        ref: '',
        role: 'generic',
        name: `(${opts.x}, ${opts.y})`,
        tag: 'div',
      }
    }
    if (!opts.ref && !opts.name) {
      throw new BrowserError(
        'Provide ref from the snapshot, or role + name (Playwright getByRole).',
      )
    }
    if (!opts.ref) {
      if (!isSnapshotDegraded(targetId)) {
        throw new BrowserError(
          'browser_click with role + name is only allowed after a snapshot timeout. Take a snapshot and click the ref.',
        )
      }
    }
    const expected = opts.ref ? getRefMeta(targetId, opts.ref) : undefined
    let loc = opts.ref
      ? refLocator(page, opts.ref)
      : await locateByRoleName(page, opts.role ?? 'button', opts.name!)
    let relocated = false
    if (opts.ref && (await loc.count().catch(() => 0)) === 0) {
      const role = opts.role ?? expected?.role ?? 'button'
      const name = opts.name ?? expected?.name
      if (!name) {
        throw new StaleRefError(
          `No element for ref ${opts.ref}. The page changed; take a fresh snapshot.`,
        )
      }
      try {
        loc = await locateByRoleName(page, role, name)
        relocated = true
      } catch {
        throw new StaleRefError(
          `No element for ref ${opts.ref} (was ${role} "${name}"). The page changed; take a fresh snapshot.`,
        )
      }
    }
    const described = await describeElement(loc, opts.ref ?? opts.name ?? 'target')
    assertClickSemantics(described, expected, opts.element)
    const urlBefore = page.url()
    await withActionWait(page, async () => {
      const args = {
        timeout: ACTION_TIMEOUT_MS,
        button: opts.button,
        modifiers,
        force: opts.force,
      }
      if (opts.doubleClick) await loc.dblclick(args)
      else await loc.click(args)
    })
    throwIfUnarmedDestructiveDialog(page)
    await settleIfUrlChanged(page, urlBefore)
    return relocated
      ? { ...described, name: `${described.name} (relocated after stale ref)` }
      : described
  } catch (err) {
    mapPlaywrightError(err, opts.ref)
  }
}

export async function drag(
  backend: BrowserBackend,
  targetId: string,
  opts: { startRef: string; endRef: string },
): Promise<void> {
  const page = await getPageForTarget(backend, targetId)
  try {
    await page.bringToFront().catch(() => {})
    const start = refLocator(page, opts.startRef)
    const end = refLocator(page, opts.endRef)
    await start.dragTo(end, { timeout: ACTION_TIMEOUT_MS })
  } catch (err) {
    mapPlaywrightError(err, opts.startRef)
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
    await page.bringToFront().catch(() => {})
    const selected = await withActionWait(page, () => pickValue(loc, values))
    throwIfUnarmedDestructiveDialog(page)
    return selected
  } catch (err) {
    mapPlaywrightError(err, ref)
  }
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
  const page = await getPageForTarget(backend, targetId)
  try {
    await page.bringToFront().catch(() => {})
    // No network drain: attaching a file often starts a PDF/viewer fetch that
    // never goes idle, and waiting for it is what made upload look hung.
    return await uploadFiles(page, opts)
  } catch (err) {
    mapPlaywrightError(err, opts.ref)
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
    throwIfUnarmedDestructiveDialog(page)
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
    if (deltaX || deltaY) await page.mouse.wheel(deltaX, deltaY)
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
    if (opts.ref && opts.fullPage) {
      throw new BrowserError('fullPage is not supported for element screenshots')
    }
    const take = async () =>
      opts.ref
        ? await refLocator(page, opts.ref).screenshot({
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
}
