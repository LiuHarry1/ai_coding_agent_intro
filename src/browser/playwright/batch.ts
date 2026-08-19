/** Run several in-page actions in one trip. */
import type { Frame, Page } from 'playwright-core'
import {
  ACT_MAX_BATCH_ACTIONS,
  ACT_MAX_BATCH_DEPTH,
} from '../limits.js'
import type { BrowserBackend, FormField } from '../types.js'
import { BrowserError } from '../types.js'
import {
  click,
  drag,
  hover,
  pressKey,
  resizeViewport,
  scrollIntoView,
  selectOption,
  typeText,
} from './actions.js'
import { fillForm } from './forms.js'
import { waitFor } from './snapshot.js'
import { evaluate } from './evaluate.js'
import { getPageForTarget } from './connect.js'
import type {
  BrowserActRequest,
  BrowserBatchAbort,
  BrowserBatchActionResult,
} from './act-types.js'

function formFieldsFromAct(
  fields: Array<{ ref: string; type?: string; value?: string | number | boolean }>,
): FormField[] {
  return fields.map(field => ({
    ref: field.ref,
    value: field.value == null ? '' : String(field.value),
    kind:
      field.type === 'checkbox' || field.type === 'radio' || field.type === 'combobox'
        ? field.type
        : 'textbox',
  }))
}

async function executeSingleAction(
  backend: BrowserBackend,
  targetId: string,
  action: BrowserActRequest,
  evaluateEnabled: boolean,
  depth: number,
): Promise<unknown> {
  if (depth > ACT_MAX_BATCH_DEPTH) {
    throw new Error(`Batch nesting depth exceeds maximum of ${ACT_MAX_BATCH_DEPTH}`)
  }
  switch (action.kind) {
    case 'click':
      await click(backend, targetId, {
        ref: action.ref,
        doubleClick: action.doubleClick,
        button: action.button as 'left' | 'right' | 'middle' | undefined,
        modifiers: action.modifiers as Array<'Alt' | 'Control' | 'Meta' | 'Shift'> | undefined,
        x: action.x,
        y: action.y,
      })
      break
    case 'clickCoords':
      await click(backend, targetId, {
        x: action.x,
        y: action.y,
        doubleClick: action.doubleClick,
        button: action.button as 'left' | 'right' | 'middle' | undefined,
      })
      break
    case 'type':
      await typeText(backend, targetId, {
        ref: action.ref,
        text: action.text,
        submit: action.submit,
        slowly: action.slowly,
      })
      break
    case 'press':
      await pressKey(backend, targetId, action.key, action.modifiers)
      break
    case 'hover':
      await hover(backend, targetId, { ref: action.ref })
      break
    case 'scrollIntoView':
      await scrollIntoView(backend, targetId, action.ref)
      break
    case 'drag':
      await drag(backend, targetId, {
        startRef: action.startRef,
        endRef: action.endRef,
      })
      break
    case 'select':
      await selectOption(backend, targetId, action.ref, action.values)
      break
    case 'fill':
      await fillForm(backend, targetId, formFieldsFromAct(action.fields))
      break
    case 'resize':
      await resizeViewport(backend, targetId, action.width, action.height)
      break
    case 'wait':
      await waitFor(backend, targetId, {
        time: action.timeMs != null ? action.timeMs / 1000 : undefined,
        text: action.text,
        textGone: action.textGone,
        selector: action.selector,
        url: action.url,
      })
      break
    case 'evaluate':
      if (!evaluateEnabled) {
        throw new Error(
          'act:evaluate is disabled by config (browser.evaluateEnabled=false)',
        )
      }
      return await evaluate(backend, targetId, action.fn, { ref: action.ref })
    case 'batch':
      await batchActions(backend, targetId, {
        actions: action.actions,
        stopOnError: action.stopOnError,
        evaluateEnabled,
        depth: depth + 1,
      })
      break
    default:
      throw new Error(
        `Unsupported batch action kind: ${(action as { kind: string }).kind}`,
      )
  }
  return undefined
}

export async function batchActions(
  backend: BrowserBackend,
  targetId: string,
  opts: {
    actions: BrowserActRequest[]
    stopOnError?: boolean
    evaluateEnabled?: boolean
    depth?: number
    page?: Page
  },
): Promise<{ results: BrowserBatchActionResult[]; aborted?: BrowserBatchAbort }> {
  const depth = opts.depth ?? 0
  if (depth > ACT_MAX_BATCH_DEPTH) {
    throw new Error(`Batch nesting depth exceeds maximum of ${ACT_MAX_BATCH_DEPTH}`)
  }
  if (opts.actions.length > ACT_MAX_BATCH_ACTIONS) {
    throw new Error(`Batch exceeds maximum of ${ACT_MAX_BATCH_ACTIONS} actions`)
  }
  const page = opts.page ?? (await getPageForTarget(backend, targetId))
  const evaluateEnabled = opts.evaluateEnabled !== false
  const results: BrowserBatchActionResult[] = []
  const finishAborted = (
    reason: BrowserBatchAbort['reason'],
    afterAction: number,
    url: string,
    skipped: number,
  ) =>
    skipped === 0
      ? { results }
      : { results, aborted: { reason, afterAction, url, skipped } }

  let mainFrameNavigations = 0
  let navigationsAtLastDispatch = 0
  const currentMainFrameUrl = () => page.mainFrame?.().url() ?? page.url()
  const onFrameNavigated = (frame: Frame) => {
    if (frame === page.mainFrame?.()) {
      mainFrameNavigations += 1
    }
  }
  const finishNavigation = (afterAction: number, skipped: number) => {
    const url = currentMainFrameUrl()
    const lastResult = results.at(-1)
    if (lastResult) {
      results[results.length - 1] = { ...lastResult, navigated: true, url }
    }
    return finishAborted('navigation', afterAction, url, skipped)
  }

  page.on?.('framenavigated', onFrameNavigated)
  try {
    for (const [index, action] of opts.actions.entries()) {
      if (mainFrameNavigations > navigationsAtLastDispatch) {
        return finishNavigation(index, opts.actions.length - index)
      }
      if (page.isClosed?.()) {
        return finishAborted(
          'closed',
          index,
          currentMainFrameUrl(),
          opts.actions.length - index,
        )
      }
      navigationsAtLastDispatch = mainFrameNavigations
      try {
        await executeSingleAction(
          backend,
          targetId,
          action,
          evaluateEnabled,
          depth,
        )
        results.push({ ok: true })
        if (page.isClosed?.()) {
          return finishAborted(
            'closed',
            index + 1,
            currentMainFrameUrl(),
            opts.actions.length - index - 1,
          )
        }
        if (mainFrameNavigations > navigationsAtLastDispatch) {
          return finishNavigation(index + 1, opts.actions.length - index - 1)
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        results.push({ ok: false, error: message })
        if (page.isClosed?.()) {
          return finishAborted(
            'closed',
            index + 1,
            currentMainFrameUrl(),
            opts.actions.length - index - 1,
          )
        }
        if (mainFrameNavigations > navigationsAtLastDispatch) {
          return finishNavigation(index + 1, opts.actions.length - index - 1)
        }
        if (opts.stopOnError !== false) {
          break
        }
      }
    }
    return { results }
  } finally {
    page.off?.('framenavigated', onFrameNavigated)
  }
}

export function assertEvaluateEnabled(enabled: boolean | undefined): void {
  if (enabled === false) {
    throw new BrowserError(
      'act:evaluate is disabled by config (browser.evaluateEnabled=false)',
    )
  }
}
