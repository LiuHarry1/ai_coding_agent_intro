/**
 * Which snapshot/click engine the tools use.
 *
 *   cdp         — injected distiller + Input.dispatchMouseEvent (the original path)
 *   playwright  — OpenClaw's path: page.ariaSnapshot({ mode: 'ai' }) and
 *                 locator('aria-ref=eN').click() via playwright-core
 *
 * Tests lock this so a developer settings.json cannot flip the conformance
 * suites onto a different engine mid-run. Product default is playwright.
 */

export type BrowserEngine = 'cdp' | 'playwright'

let engine: BrowserEngine = 'playwright'
let locked = false

export function setBrowserEngine(next: BrowserEngine, lock = false): void {
  if (locked && !lock) return
  engine = next
  if (lock) locked = true
}

export function unlockBrowserEngine(): void {
  locked = false
}

export function getBrowserEngine(): BrowserEngine {
  return engine
}
