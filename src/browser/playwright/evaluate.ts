/**
 * OpenClaw `evaluateViaPlaywright`: run JS in the page (or on a ref's node)
 * through Playwright `page.evaluate` / `locator.evaluate`, with an in-page
 * timeout so a hung promise cannot stall the command queue.
 */

import type { Page } from 'playwright-core'
import { normalizeBrowserEvaluateFunctionSource } from '../evaluate-source.js'
import { BrowserError, type BrowserBackend } from '../types.js'
import { wrapPageExpression } from '../page-inspect.js'
import { getPageForTarget } from './connect.js'
import { mapPlaywrightError, refLocator } from './locator.js'

const DEFAULT_EVALUATE_MS = 20_000

async function cdpEvaluate(
  backend: BrowserBackend,
  targetId: string,
  source: string,
): Promise<unknown> {
  const wrapped = wrapPageExpression(source)
  const res = await backend.send<{
    result?: { value?: unknown }
    exceptionDetails?: { text?: string; exception?: { description?: string } }
  }>(targetId, 'Runtime.evaluate', {
    expression: wrapped,
    returnByValue: true,
    awaitPromise: true,
  })
  if (res.exceptionDetails) {
    const detail =
      res.exceptionDetails.exception?.description ??
      res.exceptionDetails.text ??
      'unknown error'
    throw new BrowserError(`Page script error: ${detail}`)
  }
  return res.result?.value
}

export async function evaluate(
  backend: BrowserBackend,
  targetId: string,
  fn: string,
  opts: { ref?: string; timeoutMs?: number } = {},
): Promise<unknown> {
  const fnText = (fn || '').trim()
  if (!fnText) throw new BrowserError('function is required')

  let page: Page
  try {
    page = await getPageForTarget(backend, targetId)
  } catch {
    return cdpEvaluate(backend, targetId, fnText)
  }

  const outerTimeout = Math.max(
    1000,
    Math.min(120_000, Math.floor(opts.timeoutMs ?? DEFAULT_EVALUATE_MS)),
  )
  const evaluateTimeout = Math.max(1000, Math.min(120_000, outerTimeout - 500))
  const fnBody = normalizeBrowserEvaluateFunctionSource(fnText, {
    argumentName: opts.ref ? 'el' : undefined,
  })

  try {
    if (opts.ref) {
      const locator = refLocator(page, opts.ref)
      const elementEvaluator = new Function(
        'el',
        'args',
        `
"use strict";
var fnBody = args.fnBody, timeoutMs = args.timeoutMs;
try {
  var candidate = eval("(" + fnBody + ")");
  var result = typeof candidate === "function" ? candidate(el) : candidate;
  if (result && typeof result.then === "function") {
    return Promise.race([
      result,
      new Promise(function (_, reject) {
        setTimeout(function () {
          reject(new Error("evaluate timed out after " + timeoutMs + "ms"));
        }, timeoutMs);
      }),
    ]);
  }
  return result;
} catch (err) {
  throw new Error("Invalid evaluate function: " + (err && err.message ? err.message : String(err)));
}
`,
      ) as (
        el: Element,
        args: { fnBody: string; timeoutMs: number },
      ) => unknown
      return await locator.evaluate(elementEvaluator, {
        fnBody,
        timeoutMs: evaluateTimeout,
      })
    }

    const browserEvaluator = new Function(
      'args',
      `
"use strict";
var fnBody = args.fnBody, timeoutMs = args.timeoutMs;
try {
  var candidate = eval("(" + fnBody + ")");
  var result = typeof candidate === "function" ? candidate() : candidate;
  if (result && typeof result.then === "function") {
    return Promise.race([
      result,
      new Promise(function (_, reject) {
        setTimeout(function () {
          reject(new Error("evaluate timed out after " + timeoutMs + "ms"));
        }, timeoutMs);
      }),
    ]);
  }
  return result;
} catch (err) {
  throw new Error("Invalid evaluate function: " + (err && err.message ? err.message : String(err)));
}
`,
    ) as (args: { fnBody: string; timeoutMs: number }) => unknown
    return await page.evaluate(browserEvaluator, {
      fnBody,
      timeoutMs: evaluateTimeout,
    })
  } catch (err) {
    mapPlaywrightError(err, opts.ref)
  }
}
