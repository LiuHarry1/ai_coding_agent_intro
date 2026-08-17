/**
 * Writing text into a control and confirming it stuck.
 *
 * Shared by `browser_type` and `browser_fill_form`, which used to carry two
 * near-identical copies of this and drifted apart on the retry rule.
 */

import type { Locator, Page } from 'playwright-core'
import { ACTION_TIMEOUT_MS } from '../limits.js'

/**
 * Widgets reformat as you type — thousands separators, phone masks, trimmed
 * whitespace — so the value read back is routinely not the string we sent
 * without the write having failed.
 */
export function valuesMatch(expected: string, actual: string): boolean {
  const strip = (s: string) => s.replace(/,/g, '').replace(/\s/g, '')
  return strip(actual) === strip(expected) || actual.includes(expected)
}

export async function readValue(field: Locator): Promise<string> {
  return field
    .evaluate(node => {
      const target = node as HTMLInputElement
      const asElement = target as unknown as HTMLElement
      return asElement.isContentEditable
        ? (asElement.innerText || '').trim()
        : (target.value ?? '')
    })
    .catch(() => '')
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

/**
 * Replace the field's contents and return what it actually holds afterwards.
 *
 * `fill` sets the value and fires one input event, which a masked or
 * autocomplete-backed widget can swallow while keeping its own state. The read
 * back is what catches that, and it doubles as the value the caller reports —
 * so verifying costs no extra round trip.
 */
export async function writeText(
  page: Page,
  field: Locator,
  text: string,
  opts: { slowly?: boolean } = {},
): Promise<string> {
  if (opts.slowly) {
    await typeViaKeyboard(page, field, text)
    return readValue(field)
  }

  try {
    await field.fill(text, { timeout: ACTION_TIMEOUT_MS, noWaitAfter: true })
  } catch {
    await typeViaKeyboard(page, field, text)
  }

  const got = await readValue(field)
  if (valuesMatch(text, got)) return got

  await typeViaKeyboard(page, field, text)
  return readValue(field)
}
