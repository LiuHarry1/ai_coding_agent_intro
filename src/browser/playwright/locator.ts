/**
 * Turning an `eN` ref from the snapshot into a Playwright locator, and into a
 * description the tool layer can put in a message.
 */

import type { Locator, Page } from 'playwright-core'
import { BrowserError, StaleRefError, type ResolvedElement } from '../types.js'

export function normalizeRef(ref: string): string {
  const trimmed = ref.trim()
  if (trimmed.startsWith('@')) return trimmed.slice(1)
  if (trimmed.startsWith('ref=')) return trimmed.slice(4)
  return trimmed
}

export function refLocator(page: Page, ref: string): Locator {
  return page.locator(`aria-ref=${normalizeRef(ref)}`)
}

const STALE =
  /No node found for selector|strict mode violation|element was detached/i
/**
 * Playwright logs this line once the selector matched something. Its presence in
 * a timeout is the difference between the two failures the model must tell
 * apart: a ref that points at nothing any more, and an element that is right
 * there but refusing the action because something covers it.
 */
const RESOLVED = /locator resolved to/i
const TIMED_OUT = /Timeout|waiting for locator/i

function staleText(ref?: string): string {
  return ref
    ? `No element for ref ${ref}. The page changed; take a fresh snapshot.`
    : 'Playwright could not find the target. Take a fresh snapshot.'
}

/**
 * Why an element that exists refused the action. Playwright's call log already
 * names the overlay that swallowed the click; flattening it to a timeout threw
 * away the one detail that tells the model what to do next.
 */
function notActionableText(message: string, ref?: string): string {
  const lines = message.split('\n').map(l => l.trim().replace(/^-\s*/, ''))
  const what = ref ? `ref ${ref}` : 'the element'
  const blocker = lines.find(l => l.includes('intercepts pointer events'))
  if (blocker) {
    return `Action on ${what} was blocked: ${blocker}. Dismiss the overlay or act on it instead.`
  }
  const why = lines.find(l => /element is not (visible|enabled|stable)/i.test(l))
  if (why) return `${what} never became actionable: ${why}.`
  return `${what} did not accept the action in time. Take a fresh snapshot to see the current state.`
}

export function mapPlaywrightError(err: unknown, ref?: string): never {
  const message = err instanceof Error ? err.message : String(err)
  if (STALE.test(message)) throw new StaleRefError(staleText(ref))
  if (RESOLVED.test(message)) {
    throw new BrowserError(notActionableText(message, ref))
  }
  if (TIMED_OUT.test(message)) throw new StaleRefError(staleText(ref))
  throw new BrowserError(message)
}

/**
 * The same classification as one line, for a failure that belongs to a single
 * field of a batch and must not throw away the fields that did land.
 */
export function briefError(err: unknown, ref: string): string {
  const message = err instanceof Error ? err.message : String(err)
  if (STALE.test(message)) return `no element for ref ${ref} — take a fresh snapshot`
  if (RESOLVED.test(message)) return notActionableText(message, ref)
  if (TIMED_OUT.test(message)) {
    return `no element for ref ${ref} — take a fresh snapshot`
  }
  return message.split('\n')[0] ?? message
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

/**
 * The control to write into. Aria-refs often land on a wrapper, and `fill` has
 * to hit the real input — which `describeElement` already located, so this
 * needs no round trip of its own.
 */
export function editableTarget(
  loc: Locator,
  described: DescribedElement,
): Locator {
  if (described.field === 'self') return loc
  return loc
    .locator(
      described.field === 'nested-visible'
        ? VISIBLE_EDITABLE_SELECTOR
        : EDITABLE_SELECTOR,
    )
    .first()
}
