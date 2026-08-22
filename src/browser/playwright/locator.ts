/**
 * Turning an `eN` ref from the snapshot into a Playwright locator, and into a
 * description the tool layer can put in a message.
 */

import type { Locator, Page } from 'playwright-core'
import { elementMatchesHint } from '../snapshot-index.js'
import { BrowserError, StaleRefError, type ResolvedElement } from '../types.js'

const SNAPSHOT_REF = /^(f\d+)?e\d+$/

export function normalizeRef(ref: string): string {
  const trimmed = ref.trim()
  if (trimmed.startsWith('@')) return trimmed.slice(1)
  if (trimmed.startsWith('ref=')) return trimmed.slice(4)
  return trimmed
}

export function refLocator(page: Page, ref: string): Locator {
  return page.locator(`aria-ref=${normalizeRef(ref)}`)
}

/**
 * Resolve a snapshot ref to a live locator, matching Playwright MCP's
 * `tab.targetLocator`: aria-ref only, fail fast when the ref is missing.
 */
export async function targetLocator(
  page: Page,
  params: { ref: string; element?: string },
): Promise<Locator> {
  const ref = normalizeRef(params.ref)
  if (!SNAPSHOT_REF.test(ref)) {
    throw new BrowserError(
      `"${params.ref}" does not match a snapshot ref (expected e.g. e12).`,
    )
  }
  let locator = page.locator(`aria-ref=${ref}`)
  if (params.element) locator = locator.describe(params.element)
  try {
    await locator.normalize()
  } catch {
    throw new StaleRefError(
      `Ref ${ref} not found in the current page snapshot. Try capturing new snapshot.`,
    )
  }
  return locator
}

/** When the model passes `element`, refuse a ref that no longer matches. */
export function assertElementHint(
  described: { role: string; name: string },
  hint: string | undefined,
  ref: string,
): void {
  if (!hint?.trim()) return
  if (!elementMatchesHint(described, hint)) {
    throw new BrowserError(
      `Ref ${ref} resolved to ${described.role} "${described.name}", which does not match ${JSON.stringify(hint)}. Capture a new snapshot.`,
    )
  }
}

/**
 * Playwright's locator failures become the next snapshot/click the model
 * should take.
 */
export function toAIFriendlyMessage(error: unknown, selector: string): string {
  const message = error instanceof Error ? error.message : String(error)

  if (message.includes('strict mode violation')) {
    const countMatch = message.match(/resolved to (\d+) elements/)
    const count = countMatch ? countMatch[1] : 'multiple'
    return (
      `Selector "${selector}" matched ${count} elements. ` +
      `Run a new snapshot to get updated refs, or use a different ref.`
    )
  }

  if (
    message.includes('not found in the current page snapshot') ||
    message.includes('Stale aria-ref') ||
    /aria-ref=e\d+.*not found/i.test(message)
  ) {
    return `Ref ${selector} not found in the current page snapshot. Try capturing new snapshot.`
  }

  if (
    (message.includes('Timeout') || message.includes('waiting for')) &&
    (message.includes('to be visible') ||
      message.includes('not visible') ||
      message.includes('waiting for locator('))
  ) {
    return (
      `Element "${selector}" not found or not visible. ` +
      `Try capturing new snapshot.`
    )
  }

  if (
    message.includes('intercepts pointer events') ||
    message.includes('not visible') ||
    message.includes('not receive pointer events')
  ) {
    return (
      `Element "${selector}" is not interactable (hidden or covered). ` +
      `Try scrolling it into view, closing overlays, or re-snapshotting.`
    )
  }

  return message
}

export function mapPlaywrightError(err: unknown, ref?: string): never {
  throw new BrowserError(toAIFriendlyMessage(err, ref || 'element'))
}

export function briefError(err: unknown, ref: string): string {
  return toAIFriendlyMessage(err, ref).split('\n')[0] ?? toAIFriendlyMessage(err, ref)
}

const EDITABLE_PARTS = [
  'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"])',
  'textarea',
  '[contenteditable="true"]',
]

const EDITABLE_SELECTOR = EDITABLE_PARTS.join(', ')
const VISIBLE_EDITABLE_SELECTOR = EDITABLE_PARTS.map(p => `${p}:visible`).join(
  ', ',
)

export interface DescribedElement extends ResolvedElement {
  /** Where the editable control is, relative to the ref'd element. */
  field: 'self' | 'nested-visible' | 'nested-hidden'
}

/**
 * Identity and field state in a single round trip.
 *
 * This used to be three calls — `boundingBox()`, a describe evaluate, and a
 * separate read of the input's value — which over the extension relay is three
 * WebSocket waits per action. Geometry is gone because locators hit-test
 * themselves, and the value read merged in here because the same page visit can
 * answer both questions.
 */
export async function describeElement(
  loc: Locator,
  ref: string,
): Promise<DescribedElement> {
  const info = await loc
    // No named inner functions below: the bundler rewrites them into `__name`
    // calls that do not exist in the page.
    .evaluate((node, selector) => {
      const self = node as HTMLElement
      const own =
        self instanceof HTMLInputElement ||
        self instanceof HTMLTextAreaElement ||
        self.isContentEditable
      let nested: HTMLElement | null = null
      let nestedVisible = false
      if (!own) {
        const found = self.querySelectorAll(selector)
        for (let i = 0; i < found.length; i++) {
          const candidate = found[i] as HTMLElement
          if (
            candidate.offsetParent !== null ||
            candidate.getClientRects().length > 0
          ) {
            nested = candidate
            nestedVisible = true
            break
          }
        }
        // A control hidden behind a styled label is still the one to write to.
        if (!nested && found.length > 0) nested = found[0] as HTMLElement
      }

      const target = (nested ?? self) as HTMLInputElement
      const type = target.type || ''
      const explicit = self.getAttribute('role')
      const role = explicit
        ? explicit
        : self instanceof HTMLInputElement
          ? type === 'submit' || type === 'button' || type === 'reset'
            ? 'button'
            : type === 'checkbox' || type === 'radio'
              ? type
              : 'textbox'
          : self.tagName.toLowerCase()
      const name = (
        self.getAttribute('aria-label') ||
        // A form control's text lives in its <label>, not inside the element.
        ((self as HTMLInputElement).labels?.[0]?.textContent ?? '') ||
        (self instanceof HTMLInputElement ? self.placeholder : '') ||
        (self.textContent || '')
      )
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120)

      return {
        role,
        name,
        tag: self.tagName.toLowerCase(),
        value: (target as unknown as HTMLElement).isContentEditable
          ? ((target as unknown as HTMLElement).innerText || '').trim()
          : (target.value ?? ''),
        readOnly: Boolean(target.readOnly),
        disabled: Boolean(target.disabled),
        field: !nested
          ? ('self' as const)
          : nestedVisible
            ? ('nested-visible' as const)
            : ('nested-hidden' as const),
      }
    }, EDITABLE_SELECTOR)
    .catch(() => null)

  if (!info) {
    return { ref, role: 'generic', name: ref, tag: 'div', field: 'self' }
  }
  return { ref, ...info }
}

