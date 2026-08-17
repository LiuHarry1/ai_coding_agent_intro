/**
 * The injected-script channel: console output, fetch/XHR traffic, and raw
 * expression evaluation.
 *
 * This is everything the browser tools cannot get from Playwright. Console and
 * network are event streams, and a `BrowserBackend` only speaks request/response
 * CDP, so the page buffers them (see `page-script.ts`) and we drain on demand.
 *
 * Snapshot, click, type and fill live in `playwright/` instead — it drives the
 * same tab and already has an accessibility tree and actionability checks.
 */

import { PAGE_SCRIPT } from './page-script.js'
import {
  BrowserError,
  type BrowserBackend,
  type ConsoleEntry,
  type NetworkEntry,
} from './types.js'

interface RuntimeEvaluateResult {
  result?: { type: string; value?: unknown }
  exceptionDetails?: {
    text?: string
    exception?: { description?: string; value?: unknown }
  }
}

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

/** Targets whose document already carries the script and the install hook. */
const installed = new WeakMap<BrowserBackend, Set<string>>()

async function install(
  backend: BrowserBackend,
  targetId: string,
): Promise<void> {
  await backend.send(targetId, 'Page.enable').catch(() => {})
  await backend.send(targetId, 'Runtime.enable').catch(() => {})
  // The hook covers future navigations, so console capture starts at the very
  // first line of the next page; the direct evaluate covers the open document.
  await backend.send(targetId, 'Page.addScriptToEvaluateOnNewDocument', {
    source: PAGE_SCRIPT,
  })
  await evaluate(backend, targetId, PAGE_SCRIPT)
}

/**
 * Install the page script once per target.
 *
 * Deliberately not a version check on every call: that was a full round trip
 * in front of every console read and every post-action report, and the
 * add-on-new-document hook means the script is already there. `callPage`
 * repairs the one case this misses.
 *
 * Call this before a navigation the console hooks must survive.
 */
export async function ensureScript(
  backend: BrowserBackend,
  targetId: string,
): Promise<void> {
  let seen = installed.get(backend)
  if (!seen) {
    seen = new Set()
    installed.set(backend, seen)
  }
  if (seen.has(targetId)) return
  await install(backend, targetId)
  seen.add(targetId)
}

function encodeArgs(args: unknown[]): string {
  return args.map(a => JSON.stringify(a ?? null)).join(', ')
}

/**
 * Call into the page script, reinstalling if the global is gone.
 *
 * These page functions are pure filters over an in-memory buffer, so an error
 * here means the script is missing (a document that loaded before our hook
 * landed), not that the arguments were bad. That makes a blind retry the
 * cheapest correct answer — and it keeps the happy path at one round trip.
 */
async function callPage<T>(
  backend: BrowserBackend,
  targetId: string,
  fn: string,
  args: unknown[],
): Promise<T> {
  await ensureScript(backend, targetId)
  const expression = `window.__agentBrowser.${fn}(${encodeArgs(args)})`
  try {
    return await evaluate<T>(backend, targetId, expression)
  } catch {
    await install(backend, targetId)
    return evaluate<T>(backend, targetId, expression)
  }
}

export async function consoleLogs(
  backend: BrowserBackend,
  targetId: string,
  opts: { level?: string; limit?: number; since?: number } = {},
): Promise<{ entries: ConsoleEntry[]; total: number; now: number }> {
  return callPage(backend, targetId, 'consoleLogs', [opts])
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
  return callPage(backend, targetId, 'networkRequests', [opts])
}

/** Errors and broken requests since `since`, in one page call. */
export async function sinceReport(
  backend: BrowserBackend,
  targetId: string,
  since?: number,
): Promise<{ logs: ConsoleEntry[]; network: NetworkEntry[]; now: number }> {
  return callPage(backend, targetId, 'sinceReport', [since ?? null])
}

/**
 * `return (${expr})` is only valid for an expression. A statement body — one
 * that opens with `const`, `if`, a loop — becomes `return (const x = …)` and
 * dies with `Unexpected token`, so those get wrapped as a function body instead.
 */
export function wrapPageExpression(expression: string): string {
  const trimmed = expression.trim()
  try {
    // eslint-disable-next-line no-new-func
    new Function(`return (${trimmed})`)
    return `(async () => { return (${trimmed}); })()`
  } catch {
    return `(async () => { ${trimmed} })()`
  }
}

export async function evaluateExpression(
  backend: BrowserBackend,
  targetId: string,
  expression: string,
): Promise<unknown> {
  await ensureScript(backend, targetId)
  return evaluate(backend, targetId, wrapPageExpression(expression), true)
}
