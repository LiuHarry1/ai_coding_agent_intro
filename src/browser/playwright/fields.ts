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

/** Typed `MM/DD/YYYY - MM/DD/YYYY` does not bind Concur Date Range / Nights.
 *  Not in Cursor — Baize overlay for this skill's calendar widgets. */
export function isTypedDateRange(name: string, value: string): boolean {
  if (!/date\s*range|日期范围/i.test(name)) return false
  return /\d{1,2}\/\d{1,2}\/\d{2,4}\s*[-–—]\s*\d{1,2}\/\d{1,2}/.test(value)
}

export const DATE_RANGE_CALENDAR_MSG =
  'Date Range is a calendar widget. Open the calendar control and click check-in then check-out; typing the range string does not bind Nights.'

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
