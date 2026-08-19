/**
 * Fill an editable locator: `locator.fill`, or click + `locator.type` at 75ms
 * when `slowly` is set.
 */

import type { Locator } from 'playwright-core'
import { ACTION_TIMEOUT_MS } from '../limits.js'

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

export async function writeText(
  field: Locator,
  text: string,
  opts: { slowly?: boolean } = {},
): Promise<string> {
  const timeout = ACTION_TIMEOUT_MS
  if (opts.slowly) {
    await field.click({ timeout })
    await field.type(text, { timeout, delay: 75 })
  } else {
    await field.fill(text, { timeout })
  }
  return readValue(field)
}
