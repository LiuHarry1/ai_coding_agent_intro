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
import type {
  FilledField,
  FormField,
  FormFieldKind,
  ResolvedRef,
  SnapshotOpts,
  SnapshotResult,
} from '../page-ops.js'
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

/** Aria-ref is often on a wrapper; fill/type must hit the real control. */
async function resolveEditable(loc: Locator): Promise<Locator> {
  const inner = loc.locator(
    'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]), textarea, [contenteditable="true"]',
  )
  const n = await inner.count().catch(() => 0)
  for (let i = 0; i < n; i++) {
    if (await inner.nth(i).isVisible().catch(() => false)) return inner.nth(i)
  }
  if (n > 0) return inner.first()
  return loc
}

function valuesMatch(expected: string, actual: string): boolean {
  const norm = (s: string) => s.replace(/,/g, '').replace(/\s/g, '')
  return norm(actual) === norm(expected) || actual.includes(expected)
}

async function readFieldValue(field: Locator): Promise<string> {
  return (await readFieldMeta(field)).value
}

async function readFieldMeta(field: Locator): Promise<{
  value: string
  readOnly: boolean
  disabled: boolean
  type: string
  tag: string
}> {
  return field
    .evaluate(el => {
      const input =
        el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
          ? el
          : el.querySelector('input, textarea')
      const target = (input ?? el) as HTMLInputElement
      const editable = (target as unknown as HTMLElement).isContentEditable
      return {
        tag: (target as HTMLElement).tagName,
        type: target.type || '',
        readOnly: Boolean(target.readOnly),
        disabled: Boolean(target.disabled),
        value: editable
          ? ((target as unknown as HTMLElement).innerText || '').trim()
          : target.value || '',
      }
    })
    .catch(async () => ({
      tag: '',
      type: '',
      readOnly: false,
      disabled: false,
      value: await field.inputValue({ timeout: 800 }).catch(() => ''),
    }))
}

/** Select-all then type, for widgets that ignore `fill`'s single input event. */
async function typeViaKeyboard(
  page: Page,
  field: Locator,
  text: string,
): Promise<void> {
  await field.click({ timeout: ACTION_TIMEOUT_MS, noWaitAfter: true })
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('Backspace')
  await page.keyboard.type(text, { delay: 20 })
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
    // No named inner functions here: the bundler rewrites them into `__name`
    // calls that do not exist in the page.
    .evaluate(el => {
      const input = el instanceof HTMLInputElement ? el : null
      const role =
        el.getAttribute('role') ||
        (input
          ? input.type === 'submit' || input.type === 'button'
            ? 'button'
            : input.type === 'checkbox' || input.type === 'radio'
              ? input.type
              : 'textbox'
          : el.tagName.toLowerCase())
      const labelled = el as HTMLInputElement
      const name = (
        el.getAttribute('aria-label') ||
        // A form control's text lives in its <label>, not inside the element.
        (labelled.labels?.[0]?.textContent ?? '') ||
        (el instanceof HTMLInputElement ? el.placeholder : '') ||
        (el.textContent || '').replace(/\s+/g, ' ').trim()
      )
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120)
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
          noWaitAfter: true,
          button: opts.button,
          modifiers,
        })
      } else {
        await loc.click({
          timeout: ACTION_TIMEOUT_MS,
          noWaitAfter: true,
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
    const field = await resolveEditable(loc)
    const before = await readFieldMeta(field)
    if (before.readOnly || before.disabled) {
      const described = await describeLocator(loc, opts.ref).catch(() =>
        fallbackRef(opts.ref),
      )
      described.value = before.value
      described.readOnly = before.readOnly
      described.disabled = before.disabled
      return described
    }
    await withActionWait(page, async () => {
      if (opts.slowly) {
        await typeViaKeyboard(page, field, opts.text)
      } else {
        try {
          await field.fill(opts.text, {
            timeout: ACTION_TIMEOUT_MS,
            noWaitAfter: true,
          })
        } catch {
          await typeViaKeyboard(page, field, opts.text)
        }
        const got = await readFieldValue(field)
        if (!valuesMatch(opts.text, got)) {
          await typeViaKeyboard(page, field, opts.text)
        }
      }
      if (opts.submit) await page.keyboard.press('Enter')
    })
    const described = await describeLocator(loc, opts.ref).catch(() =>
      fallbackRef(opts.ref),
    )
    described.value = (await readFieldMeta(field)).value
    return described
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
    const field = await resolveEditable(loc)
    await field.fill(value, { timeout: ACTION_TIMEOUT_MS })
    const el = await describeLocator(loc, ref)
    return { role: el.role, name: el.name }
  } catch (err) {
    mapPlaywrightError(err, ref)
  }
}

/**
 * Fill several controls in one call. One bad ref must not lose the fields that
 * did land, so every field reports its own status instead of throwing, and the
 * settle/drain runs once for the batch rather than once per field.
 */
export async function fillForm(
  backend: BrowserBackend,
  targetId: string,
  fields: FormField[],
): Promise<FilledField[]> {
  const page = await getPageForTarget(backend, targetId)
  await page.bringToFront().catch(() => {})
  const results: FilledField[] = []
  await withActionWait(page, async () => {
    for (const field of fields) {
      results.push(await fillOneField(page, field))
    }
  })
  return results
}

function isTruthy(value: string): boolean {
  return ['true', '1', 'yes', 'on', 'checked'].includes(value.trim().toLowerCase())
}

function inferKind(el: ResolvedRef): FormFieldKind {
  if (el.role === 'checkbox' || el.role === 'switch') return 'checkbox'
  if (el.role === 'radio') return 'radio'
  if (el.tag === 'select') return 'combobox'
  return 'textbox'
}

function fieldError(err: unknown, ref: string): string {
  const message = err instanceof Error ? err.message : String(err)
  if (
    /Timeout|strict mode violation|waiting for locator|No node found for selector/i.test(
      message,
    )
  ) {
    return `no element for ref ${ref} — take a fresh snapshot`
  }
  return message.split('\n')[0] ?? message
}

async function fillOneField(page: Page, field: FormField): Promise<FilledField> {
  const loc = refLocator(page, field.ref)
  const el = await describeLocator(loc, field.ref).catch(() =>
    fallbackRef(field.ref),
  )
  const base = { ref: field.ref, role: el.role, name: el.name }
  try {
    const kind = field.kind ?? inferKind(el)
    if (kind === 'checkbox' || kind === 'radio') {
      const on = isTruthy(field.value)
      // force: the real input is routinely hidden behind a styled label.
      await loc.setChecked(on, { timeout: ACTION_TIMEOUT_MS, force: true })
      return { ...base, value: String(on), status: 'filled' }
    }
    if (kind === 'combobox' && el.tag === 'select') {
      const selected = await loc.selectOption([field.value], {
        timeout: ACTION_TIMEOUT_MS,
      })
      return { ...base, value: selected.join(', '), status: 'filled' }
    }

    const target = await resolveEditable(loc)
    const meta = await readFieldMeta(target)
    if (meta.readOnly || meta.disabled) {
      return {
        ...base,
        value: meta.value,
        status: 'skipped',
        reason: meta.readOnly ? 'field is readonly' : 'field is disabled',
      }
    }
    try {
      await target.fill(field.value, {
        timeout: ACTION_TIMEOUT_MS,
        noWaitAfter: true,
      })
    } catch {
      await typeViaKeyboard(page, target, field.value)
    }
    let got = await readFieldValue(target)
    if (!valuesMatch(field.value, got)) {
      await typeViaKeyboard(page, target, field.value)
      got = await readFieldValue(target)
    }
    return valuesMatch(field.value, got)
      ? { ...base, value: got, status: 'filled' }
      : {
          ...base,
          value: got,
          status: 'failed',
          reason: 'the field did not keep the value',
        }
  } catch (err) {
    return { ...base, status: 'failed', reason: fieldError(err, field.ref) }
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
