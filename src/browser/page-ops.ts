/**
 * Page operations against a `BrowserBackend`.
 *
 * Default engine (`cdp`): injected snapshot script + CDP Input.* events, so
 * the extension relay only has to forward request/response pairs.
 *
 * Playwright engine: OpenClaw's path — `ariaSnapshot({ mode: 'ai' })` and
 * `locator('aria-ref=eN')` — used when `browser.engine` is `"playwright"`.
 * Console/network still go through the injected script in both engines.
 */

import { SNAPSHOT_SCRIPT, SNAPSHOT_SCRIPT_VERSION } from './snapshot-script.js'
import { getBrowserEngine } from './engine.js'
import { BrowserError, StaleRefError, type BrowserBackend } from './types.js'
import * as pw from './pw/ops.js'

interface RuntimeEvaluateResult {
  result?: { type: string; value?: unknown }
  exceptionDetails?: {
    text?: string
    exception?: { description?: string; value?: unknown }
  }
}

export interface SnapshotResult {
  url: string
  title: string
  text: string
  nodes: number
  truncated: boolean
}

export interface ResolvedRef {
  ok: true
  ref: string
  role: string
  name: string
  x: number
  y: number
  pageX: number
  pageY: number
  width: number
  height: number
  tag: string
  isEditable: boolean
  /** Set when the original ref was stale and the element was relocated by role+name. */
  recovered?: boolean
  recoveredFrom?: string
  /** Set when something is painted on top of the click point. */
  blockingType?: 'modal' | 'overlay' | 'iframe' | 'fixed-header' | 'sibling'
  interceptedBy?: string
}

export interface ConsoleEntry {
  level: string
  text: string
  at: number
}

export interface NetworkEntry {
  id: number
  /** Which API the page used. Only these two are observable without CDP events. */
  kind: 'fetch' | 'xhr'
  method: string
  url: string
  /** 0 while pending, or when the request never reached a server. */
  status: number
  statusText: string
  ok: boolean
  pending: boolean
  /** True when the request never got a response at all (DNS, offline, CORS, abort). */
  failed: boolean
  error: string
  startedAt: number
  durationMs: number
}

const bootstrapped = new WeakMap<BrowserBackend, Set<string>>()

async function evaluate<T>(
  backend: BrowserBackend,
  targetId: string,
  expression: string,
  awaitPromise = false,
): Promise<T> {
  const res = await backend.send<RuntimeEvaluateResult>(
    targetId,
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise },
  )
  if (res.exceptionDetails) {
    const detail =
      res.exceptionDetails.exception?.description ??
      res.exceptionDetails.text ??
      'unknown error'
    throw new BrowserError(`Page script error: ${detail}`)
  }
  return res.result?.value as T
}

/**
 * Idempotently install the page-side script. `addScriptToEvaluateOnNewDocument`
 * covers future navigations (so console hooks catch logs from the very first
 * line of the next page); the direct evaluate covers the document already open.
 */
async function ensureReady(
  backend: BrowserBackend,
  targetId: string,
): Promise<void> {
  let seen = bootstrapped.get(backend)
  if (!seen) {
    seen = new Set()
    bootstrapped.set(backend, seen)
  }
  if (!seen.has(targetId)) {
    await backend.send(targetId, 'Page.enable').catch(() => {})
    await backend.send(targetId, 'Runtime.enable').catch(() => {})
    await backend.send(targetId, 'Page.addScriptToEvaluateOnNewDocument', {
      source: SNAPSHOT_SCRIPT,
    })
    seen.add(targetId)
  }

  const present = await evaluate<boolean>(
    backend,
    targetId,
    `!!(window.__agentBrowser && window.__agentBrowser.version === ${SNAPSHOT_SCRIPT_VERSION})`,
  )
  if (!present) {
    await evaluate(backend, targetId, SNAPSHOT_SCRIPT)
  }
}

function callInPage(fn: string, args: unknown[]): string {
  const encoded = args.map(a => JSON.stringify(a ?? null)).join(', ')
  return `window.__agentBrowser.${fn}(${encoded})`
}

/**
 * Make the tab visible before dispatching input at it.
 *
 * Chrome discards `Input.*` events aimed at a hidden tab: the command returns
 * success, the renderer never sees them, and the click silently does nothing.
 * The extension backend opens tabs in the background so it doesn't yank the
 * user's focus, which puts every tab in exactly that state. Activating also
 * reflows the viewport (tab strip and toolbar change the height), so this has
 * to run before any coordinate is measured, not just before the dispatch.
 */
async function focusTarget(
  backend: BrowserBackend,
  targetId: string,
): Promise<void> {
  await ensureReady(backend, targetId)
  await backend.send(targetId, 'Page.bringToFront').catch(() => {})
  // Two frames is when the post-activation layout has settled; the timeout is
  // the escape hatch for a page that stays hidden, where rAF never fires.
  const state = await evaluate<string>(
    backend,
    targetId,
    `Promise.race([
      new Promise(r => requestAnimationFrame(() => requestAnimationFrame(
        () => r(document.visibilityState)))),
      new Promise(r => setTimeout(() => r(document.visibilityState), 500))
    ])`,
    true,
  )
  if (state === 'hidden') {
    throw new BrowserError(
      'The page is still hidden after being brought to front, and Chrome ' +
        'discards input sent to a hidden page. Restore or un-minimize the ' +
        'Chrome window, then retry.',
    )
  }
}

export async function waitStable(
  backend: BrowserBackend,
  targetId: string,
  quietMs = 300,
  timeoutMs = 5000,
  minMs = 0,
): Promise<void> {
  await ensureReady(backend, targetId)
  await evaluate(
    backend,
    targetId,
    callInPage('waitStable', [quietMs, timeoutMs, minMs]),
    true,
  )
}

export async function navigate(
  backend: BrowserBackend,
  targetId: string,
  url: string,
): Promise<void> {
  if (getBrowserEngine() === 'playwright') {
    await pw.navigate(backend, targetId, url)
    return
  }
  // Ready first: the bootstrap registers the on-new-document script, which only
  // takes effect for navigations started after it is registered.
  await ensureReady(backend, targetId)
  const res = await backend.send<{ errorText?: string }>(
    targetId,
    'Page.navigate',
    { url },
  )
  if (res?.errorText) {
    throw new BrowserError(`Navigation to ${url} failed: ${res.errorText}`)
  }
  // SPAs fire complete long before the main tree (and late widgets) exist.
  // A short quiet window snapshots the chrome-only shell.
  await waitStable(backend, targetId, 800, 10000, 1500)
}

export async function historyGo(
  backend: BrowserBackend,
  targetId: string,
  delta: -1 | 1,
): Promise<void> {
  const history = await backend.send<{
    currentIndex: number
    entries: Array<{ id: number; url: string }>
  }>(targetId, 'Page.getNavigationHistory')
  const target = history.entries[history.currentIndex + delta]
  if (!target) {
    throw new BrowserError(
      delta < 0 ? 'No page to go back to.' : 'No page to go forward to.',
    )
  }
  await backend.send(targetId, 'Page.navigateToHistoryEntry', {
    entryId: target.id,
  })
  await waitStable(backend, targetId)
}

export interface SnapshotOpts {
  maxNodes?: number
  maxChars?: number
  /** CSS selector; walk this subtree instead of document.body. */
  selector?: string
  /** Skip structural wrappers (generic/group/list/…) that are not clickable. */
  compact?: boolean
}

export async function snapshot(
  backend: BrowserBackend,
  targetId: string,
  opts: SnapshotOpts = {},
): Promise<SnapshotResult> {
  if (getBrowserEngine() === 'playwright') {
    return pw.snapshot(backend, targetId, opts)
  }
  await ensureReady(backend, targetId)
  return evaluate<SnapshotResult>(
    backend,
    targetId,
    callInPage('snapshot', [
      {
        maxNodes: opts.maxNodes ?? 1500,
        maxChars: opts.maxChars ?? 20_000,
        selector: opts.selector,
        compact: opts.compact,
      },
    ]),
  )
}

const WAIT_FOR_TIMEOUT_MS = 15_000
const WAIT_FOR_TIME_CAP_S = 10
/** Match Playwright MCP's post-action settle so late DOM/XHR can land. */
const ACTION_SETTLE_MS = 500

export async function waitFor(
  backend: BrowserBackend,
  targetId: string,
  opts: { time?: number; text?: string; textGone?: string },
): Promise<void> {
  if (!opts.text && !opts.textGone && opts.time == null) {
    throw new BrowserError('Either time, text or textGone must be provided')
  }
  if (getBrowserEngine() === 'playwright') {
    await pw.waitFor(backend, targetId, opts)
    return
  }
  await ensureReady(backend, targetId)
  if (opts.time != null) {
    const ms = Math.min(WAIT_FOR_TIME_CAP_S, Math.max(0, opts.time)) * 1000
    await new Promise<void>(r => setTimeout(r, ms))
  }
  if (!opts.text && !opts.textGone) return
  const deadline = Date.now() + WAIT_FOR_TIMEOUT_MS
  while (Date.now() < deadline) {
    const body = await evaluate<string>(
      backend,
      targetId,
      `document.body ? document.body.innerText : ''`,
    )
    const appeared = !opts.text || body.includes(opts.text)
    const gone = !opts.textGone || !body.includes(opts.textGone)
    if (appeared && gone) return
    await new Promise<void>(r => setTimeout(r, 100))
  }
  const what = opts.text
    ? `text ${JSON.stringify(opts.text)} to appear`
    : `text ${JSON.stringify(opts.textGone)} to disappear`
  throw new BrowserError(`Timed out waiting for ${what}.`)
}

export async function resolveRef(
  backend: BrowserBackend,
  targetId: string,
  ref: string,
  expectedRole?: string,
  expectedName?: string,
): Promise<ResolvedRef> {
  await ensureReady(backend, targetId)
  const res = await evaluate<ResolvedRef | { error: string; message: string }>(
    backend,
    targetId,
    callInPage('resolveRef', [ref, expectedRole, expectedName]),
  )
  if ('error' in res) {
    // Every one of these means "your mental model of the page is out of date",
    // which is exactly the signal that should push the model to re-snapshot
    // rather than retry the same click.
    throw new StaleRefError(res.message)
  }
  return res
}

const MODIFIER_BITS: Record<string, number> = {
  alt: 1,
  ctrl: 2,
  control: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  shift: 8,
}

function modifierMask(modifiers?: string[]): number {
  if (!modifiers?.length) return 0
  let mask = 0
  for (const m of modifiers) {
    const bit = MODIFIER_BITS[m.toLowerCase()]
    if (bit === undefined) {
      throw new BrowserError(
        `Unknown modifier "${m}". Use one of: Alt, Control, Meta, Shift.`,
      )
    }
    mask |= bit
  }
  return mask
}

/**
 * Refuse a click that would land on something painted over the target. A real
 * user click at that point would hit the overlay, so dispatching anyway is the
 * "reports success, does nothing" trap. Only clear obstructions block: a
 * `sibling` verdict is too often a transparent label that forwards the click,
 * so those pass through rather than dead-end the model on a false positive.
 */
function assertClickable(el: ResolvedRef): void {
  const t = el.blockingType
  if (t === 'modal' || t === 'overlay' || t === 'iframe' || t === 'fixed-header') {
    const fix =
      t === 'modal'
        ? 'Close or dismiss the dialog first (look for a close button or press Escape).'
        : t === 'iframe'
          ? 'The target sits under a cross-frame element; interact with that frame or scroll it out of the way.'
          : 'Dismiss or scroll past the overlay covering it, then retry.'
    throw new BrowserError(
      `Cannot click ${el.role} "${el.name}": a ${t} (${el.interceptedBy}) is covering it. ${fix}`,
    )
  }
}

export async function click(
  backend: BrowserBackend,
  targetId: string,
  opts: {
    ref: string
    expectedRole?: string
    expectedName?: string
    button?: 'left' | 'right' | 'middle'
    doubleClick?: boolean
    modifiers?: string[]
  },
): Promise<ResolvedRef> {
  if (getBrowserEngine() === 'playwright') {
    return pw.click(backend, targetId, opts)
  }
  await focusTarget(backend, targetId)
  const el = await resolveRef(
    backend,
    targetId,
    opts.ref,
    opts.expectedRole,
    opts.expectedName,
  )
  assertClickable(el)
  const button = opts.button ?? 'left'
  const modifiers = modifierMask(opts.modifiers)
  const base = { x: el.x, y: el.y, modifiers }

  await backend.send(targetId, 'Input.dispatchMouseEvent', {
    ...base,
    type: 'mouseMoved',
    button: 'none',
  })

  const clicks = opts.doubleClick ? 2 : 1
  for (let i = 1; i <= clicks; i++) {
    await backend.send(targetId, 'Input.dispatchMouseEvent', {
      ...base,
      type: 'mousePressed',
      button,
      clickCount: i,
    })
    await backend.send(targetId, 'Input.dispatchMouseEvent', {
      ...base,
      type: 'mouseReleased',
      button,
      clickCount: i,
    })
  }

  await waitStable(backend, targetId, 200, 3000, ACTION_SETTLE_MS)
  return el
}

export async function hover(
  backend: BrowserBackend,
  targetId: string,
  opts: { ref: string; expectedRole?: string; expectedName?: string },
): Promise<ResolvedRef> {
  if (getBrowserEngine() === 'playwright') {
    return pw.hover(backend, targetId, opts)
  }
  await focusTarget(backend, targetId)
  const el = await resolveRef(
    backend,
    targetId,
    opts.ref,
    opts.expectedRole,
    opts.expectedName,
  )
  await backend.send(targetId, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: el.x,
    y: el.y,
    button: 'none',
  })
  await waitStable(backend, targetId, 200, 3000)
  return el
}

const KEY_CODES: Record<string, { code: string; vk: number; text?: string }> = {
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  Tab: { code: 'Tab', vk: 9, text: '\t' },
  Escape: { code: 'Escape', vk: 27 },
  Backspace: { code: 'Backspace', vk: 8 },
  Delete: { code: 'Delete', vk: 46 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  Home: { code: 'Home', vk: 36 },
  End: { code: 'End', vk: 35 },
  PageUp: { code: 'PageUp', vk: 33 },
  PageDown: { code: 'PageDown', vk: 34 },
  Space: { code: 'Space', vk: 32, text: ' ' },
}

export async function pressKey(
  backend: BrowserBackend,
  targetId: string,
  key: string,
  modifiers?: string[],
): Promise<void> {
  if (getBrowserEngine() === 'playwright') {
    await pw.pressKey(backend, targetId, key, modifiers)
    return
  }
  await focusTarget(backend, targetId)
  const mask = modifierMask(modifiers)
  const known = KEY_CODES[key]

  if (!known && key.length !== 1) {
    throw new BrowserError(
      `Unsupported key "${key}". Use a single character or one of: ${Object.keys(KEY_CODES).join(', ')}.`,
    )
  }

  const common = known
    ? {
        key,
        code: known.code,
        windowsVirtualKeyCode: known.vk,
        modifiers: mask,
      }
    : {
        key,
        code: `Key${key.toUpperCase()}`,
        windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0),
        modifiers: mask,
      }
  const text = known ? known.text : key

  await backend.send(targetId, 'Input.dispatchKeyEvent', {
    ...common,
    // Chrome only turns a keyDown into a character insertion when `text` is
    // present, but sending text alongside a modifier produces stray input.
    type: text && mask === 0 ? 'keyDown' : 'rawKeyDown',
    ...(text && mask === 0 ? { text, unmodifiedText: text } : {}),
  })
  await backend.send(targetId, 'Input.dispatchKeyEvent', {
    ...common,
    type: 'keyUp',
  })

  await waitStable(backend, targetId, 200, 3000, ACTION_SETTLE_MS)
}

export async function typeText(
  backend: BrowserBackend,
  targetId: string,
  opts: {
    ref: string
    text: string
    expectedRole?: string
    expectedName?: string
    /** Send real per-character key events. Needed by autocompletes that listen for keydown. */
    slowly?: boolean
    submit?: boolean
  },
): Promise<ResolvedRef> {
  if (getBrowserEngine() === 'playwright') {
    return pw.typeText(backend, targetId, opts)
  }
  await focusTarget(backend, targetId)
  const el = await resolveRef(
    backend,
    targetId,
    opts.ref,
    opts.expectedRole,
    opts.expectedName,
  )
  if (!el.isEditable) {
    throw new BrowserError(
      `Ref ${opts.ref} is a ${el.role} "${el.name}", not a text field. Use browser_click instead.`,
    )
  }

  await backend.send(targetId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: el.x,
    y: el.y,
    button: 'left',
    clickCount: 1,
  })
  await backend.send(targetId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: el.x,
    y: el.y,
    button: 'left',
    clickCount: 1,
  })

  if (opts.slowly) {
    for (const ch of opts.text) {
      await backend.send(targetId, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        text: ch,
        unmodifiedText: ch,
        key: ch,
      })
      await backend.send(targetId, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: ch,
      })
    }
  } else {
    await backend.send(targetId, 'Input.insertText', { text: opts.text })
  }

  if (opts.submit) {
    await pressKey(backend, targetId, 'Enter')
  } else {
    await waitStable(backend, targetId, 200, 3000, ACTION_SETTLE_MS)
  }
  return el
}

export async function fillField(
  backend: BrowserBackend,
  targetId: string,
  ref: string,
  value: string,
): Promise<{ role: string; name: string }> {
  if (getBrowserEngine() === 'playwright') {
    return pw.fillField(backend, targetId, ref, value)
  }
  await ensureReady(backend, targetId)
  const res = await evaluate<
    | { ok: true; role: string; name: string }
    | { error: string; message: string }
  >(backend, targetId, callInPage('setValue', [ref, value]))
  if ('error' in res) throw new StaleRefError(res.message)
  await waitStable(backend, targetId, 200, 3000)
  return res
}

export async function selectOption(
  backend: BrowserBackend,
  targetId: string,
  ref: string,
  values: string[],
): Promise<{ selected: string[] }> {
  if (getBrowserEngine() === 'playwright') {
    return pw.selectOption(backend, targetId, ref, values)
  }
  await ensureReady(backend, targetId)
  const res = await evaluate<
    { ok: true; selected: string[] } | { error: string; message: string }
  >(backend, targetId, callInPage('selectOption', [ref, values]))
  if ('error' in res) throw new StaleRefError(res.message)
  await waitStable(backend, targetId, 200, 3000)
  return res
}

export async function scroll(
  backend: BrowserBackend,
  targetId: string,
  opts: { deltaX?: number; deltaY?: number; ref?: string },
): Promise<void> {
  if (getBrowserEngine() === 'playwright') {
    await pw.scroll(backend, targetId, opts)
    return
  }
  await focusTarget(backend, targetId)
  let x = 0
  let y = 0
  if (opts.ref) {
    const el = await resolveRef(backend, targetId, opts.ref)
    x = el.x
    y = el.y
  } else {
    const size = await evaluate<{ w: number; h: number }>(
      backend,
      targetId,
      '({ w: window.innerWidth, h: window.innerHeight })',
    )
    x = size.w / 2
    y = size.h / 2
  }
  await backend.send(targetId, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x,
    y,
    deltaX: opts.deltaX ?? 0,
    deltaY: opts.deltaY ?? 0,
  })
  await waitStable(backend, targetId, 200, 3000)
}

export async function consoleLogs(
  backend: BrowserBackend,
  targetId: string,
  opts: { level?: string; limit?: number; since?: number } = {},
): Promise<{ entries: ConsoleEntry[]; total: number; now: number }> {
  await ensureReady(backend, targetId)
  return evaluate(backend, targetId, callInPage('consoleLogs', [opts]))
}

export async function networkRequests(
  backend: BrowserBackend,
  targetId: string,
  opts: {
    failedOnly?: boolean
    urlContains?: string
    limit?: number
    since?: number
  } = {},
): Promise<{ entries: NetworkEntry[]; total: number; now: number }> {
  await ensureReady(backend, targetId)
  return evaluate(backend, targetId, callInPage('networkRequests', [opts]))
}

/** Errors and broken requests since `since`, in one page call. */
export async function sinceReport(
  backend: BrowserBackend,
  targetId: string,
  since?: number,
): Promise<{ logs: ConsoleEntry[]; network: NetworkEntry[]; now: number }> {
  await ensureReady(backend, targetId)
  return evaluate(backend, targetId, callInPage('sinceReport', [since ?? null]))
}

export async function evaluateExpression(
  backend: BrowserBackend,
  targetId: string,
  expression: string,
): Promise<unknown> {
  await ensureReady(backend, targetId)
  // Wrapped so both `1 + 1` and `return foo()` style bodies work, and so a
  // returned promise is awaited.
  return evaluate(
    backend,
    targetId,
    `(async () => { return (${expression}); })()`,
    true,
  )
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
  if (getBrowserEngine() === 'playwright') {
    return pw.screenshot(backend, targetId, opts)
  }
  await ensureReady(backend, targetId)
  const format = opts.format ?? 'png'
  const params: Record<string, unknown> = { format }
  if (format === 'jpeg') params.quality = opts.quality ?? 80

  let element: ResolvedRef | undefined
  if (opts.ref) {
    element = await resolveRef(backend, targetId, opts.ref)
    const pad = 4
    params.clip = {
      x: Math.max(0, element.pageX - element.width / 2 - pad),
      y: Math.max(0, element.pageY - element.height / 2 - pad),
      width: element.width + pad * 2,
      height: element.height + pad * 2,
      scale: 1,
    }
  } else if (opts.fullPage) {
    params.captureBeyondViewport = true
  }

  const res = await backend.send<{ data: string }>(
    targetId,
    'Page.captureScreenshot',
    params,
  )
  return { buffer: Buffer.from(res.data, 'base64'), format, element }
}
