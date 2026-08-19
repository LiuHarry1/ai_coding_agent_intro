/**
 * Native `<select>`.
 *
 * Custom combobox widgets are not a select: snapshot the open popup and
 * `browser_click` the option's ref.
 */

import type { Locator } from 'playwright-core'
import { ACTION_TIMEOUT_MS } from '../limits.js'
import { BrowserError } from '../types.js'

export async function pickValue(
  loc: Locator,
  values: string[],
): Promise<{ selected: string[] }> {
  if (!values?.length) {
    throw new BrowserError('values are required')
  }
  await loc.selectOption(values, { timeout: ACTION_TIMEOUT_MS })
  return { selected: values }
}
