/**
 * Native `<select>`.
 *
 * Custom combobox widgets are not a select: snapshot the open popup and
 * `browser_click` the option's ref.
 */

import type { Locator } from 'playwright-core'
import { ACTION_TIMEOUT_MS } from '../limits.js'
import { BrowserError } from '../types.js'

const MAX_OPTIONS_IN_ERROR = 8

export async function pickValue(
  loc: Locator,
  values: string[],
): Promise<{ selected: string[] }> {
  if (!values?.length) {
    throw new BrowserError('values are required')
  }
  const control = await loc.evaluate(el => ({
    tagName: el.tagName,
    multiple: (el as HTMLSelectElement).multiple === true,
    options:
      el.tagName === 'SELECT'
        ? Array.from((el as HTMLSelectElement).options).map(option => ({
            value: option.value,
            label: option.label.replace(/\s+/g, ' ').trim(),
            text: option.text.replace(/\s+/g, ' ').trim(),
          disabled: option.disabled,
          }))
        : [],
  }))
  if (control.tagName !== 'SELECT') {
    throw new BrowserError(
      'browser_select_option only supports a native <select>; this ref is a custom combobox or another element.\n' +
        'Recovery action: browser_snapshot, then use browser_click to open the combobox and click its option',
    )
  }
  if (values.length > 1 && !control.multiple) {
    throw new BrowserError(
      'Multiple values were provided for a single-select control.\n' +
        'Recovery action: retry browser_select_option with exactly one value',
    )
  }
  const resolvedValues: string[] = []
  for (const requested of values) {
    const exact = control.options.find(
      option =>
        option.value === requested ||
        option.label === requested ||
        option.text === requested,
    )
    const normalized = requested.toLocaleLowerCase()
    const partial = exact
      ? []
      : control.options.filter(option =>
          (option.label || option.text)
            .toLocaleLowerCase()
            .includes(normalized),
        )
    if (!exact && partial.length > 1) {
      const matches = partial
        .slice(0, MAX_OPTIONS_IN_ERROR)
        .map(option => JSON.stringify(option.label || option.text || option.value))
        .join(', ')
      const more =
        partial.length > MAX_OPTIONS_IN_ERROR
          ? `, and ${partial.length - MAX_OPTIONS_IN_ERROR} more`
          : ''
      throw new BrowserError(
        `Option ${JSON.stringify(requested)} matches multiple options: ${matches}${more}.\n` +
          'Recovery action: retry browser_select_option with an exact label or value',
      )
    }
    const matched = exact ?? partial[0]
    if (!matched) {
      const available = control.options
        .map(option => option.label || option.text || option.value)
        .filter(Boolean)
      const shown = available
        .slice(0, MAX_OPTIONS_IN_ERROR)
        .map(value => JSON.stringify(value))
        .join(', ')
      const more =
        available.length > MAX_OPTIONS_IN_ERROR
          ? `, and ${available.length - MAX_OPTIONS_IN_ERROR} more`
          : ''
      throw new BrowserError(
        `Option not found: ${JSON.stringify(requested)}. ` +
          `Available options: ${shown}${more}.\n` +
          'Recovery action: retry browser_select_option with one of the available labels or values',
      )
    }
    if (matched.disabled) {
      throw new BrowserError(
        `Option ${JSON.stringify(matched.label || matched.text || matched.value)} is disabled.\n` +
          'Recovery action: choose an enabled option or ask the user how to proceed',
      )
    }
    resolvedValues.push(matched.value)
  }
  await loc.selectOption(resolvedValues, { timeout: ACTION_TIMEOUT_MS })
  return { selected: values }
}
