/**
 * Filling several controls in one call.
 *
 * One bad ref must not lose the fields that did land, so every field reports its
 * own status instead of throwing, and the settle/drain runs once for the batch
 * rather than once per field.
 */

import type { Page } from 'playwright-core'
import { ACTION_TIMEOUT_MS } from '../limits.js'
import type {
  BrowserBackend,
  FilledField,
  FormField,
  FormFieldKind,
  ResolvedElement,
} from '../types.js'
import { valuesMatch, writeText } from './fields.js'
import { briefError, describeElement, refLocator } from './locator.js'
import { pickValue } from './pick.js'
import { throwIfUnarmedDestructiveDialog } from './overlays.js'
import { withActionWait } from './settle.js'
import { getPageForTarget } from './connect.js'

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
  throwIfUnarmedDestructiveDialog(page)
  return results
}

function isTruthy(value: string): boolean {
  return ['true', '1', 'yes', 'on', 'checked'].includes(
    value.trim().toLowerCase(),
  )
}

function inferKind(el: ResolvedElement): FormFieldKind {
  if (el.role === 'checkbox' || el.role === 'switch') return 'checkbox'
  if (el.role === 'radio') return 'radio'
  if (
    el.tag === 'select' ||
    el.role === 'combobox' ||
    el.role === 'listbox'
  ) {
    return 'combobox'
  }
  return 'textbox'
}

async function fillOneField(
  page: Page,
  field: FormField,
): Promise<FilledField> {
  const loc = refLocator(page, field.ref)
  const el = await describeElement(loc, field.ref)
  const base = { ref: field.ref, role: el.role, name: el.name }
  try {
    const kind = field.kind ?? inferKind(el)

    if (kind === 'checkbox' || kind === 'radio') {
      const on = isTruthy(field.value)
      await loc.setChecked(on, { timeout: ACTION_TIMEOUT_MS })
      return { ...base, value: String(on), status: 'filled' }
    }

    if (kind === 'combobox' && el.tag === 'select') {
      const { selected } = await pickValue(loc, [field.value])
      return { ...base, value: selected.join(', '), status: 'filled' }
    }

    if (el.readOnly || el.disabled) {
      return {
        ...base,
        value: el.value,
        status: 'skipped',
        reason: el.readOnly ? 'field is readonly' : 'field is disabled',
      }
    }

    const got = await writeText(loc, field.value)
    return valuesMatch(field.value, got)
      ? { ...base, value: got, status: 'filled' }
      : {
          ...base,
          value: got,
          status: 'failed',
          reason: 'the field did not keep the value',
        }
  } catch (err) {
    return { ...base, status: 'failed', reason: briefError(err, field.ref) }
  }
}
