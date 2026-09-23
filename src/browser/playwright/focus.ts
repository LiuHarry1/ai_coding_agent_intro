/**
 * Silent extension automation: no Page.bringToFront, no window focus.
 *
 * Reads (snapshot, navigate) run on the background agent tab (L0).
 * Writes (click, type) and screenshots only call tabs.update({ active: true })
 * — L1 tab strip, not windows.update({ focused }) and not CDP bringToFront
 * [OpenClaw PR #105356].
 *
 * Chrome may still reject input on a fully background tab; L1 is the minimum
 * without stealing the window. For zero tab-bar changes, use isolated mode
 * (a separate Chrome window) [Codex scene split].
 *
 * restoreTabAfterInput defaults to false so the agent does not bounce the user
 * between tabs after every action.
 */

import type { Page } from 'playwright-core'
import { BrowserError, type BrowserBackend } from '../types.js'
import { getPageForTarget } from './connect.js'

const RENDER_PROBE_MS = 1_500

export const NOT_RENDERING_MESSAGE =
  'Chrome is not rendering this tab: its window is minimized or completely covered by other windows, ' +
  'so screenshots and clicks cannot complete. Stop and ask the user to restore the Chrome window ' +
  '(it does not need focus), then retry. Do not retry in a loop.'

export type FocusLevel = 'tab' | 'window'

const RESTORE_DEBOUNCE_MS = 600

let restoreTabAfterInput = false
let inputFocusDepth = 0

let pendingRestore: {
  backend: BrowserBackend
  userTab: string
  agentTab: string
} | null = null
let restoreTimer: NodeJS.Timeout | null = null

export function applyFocusConfig(opts: {
  restoreTabAfterInput?: boolean
}): void {
  if (opts.restoreTabAfterInput !== undefined) {
    restoreTabAfterInput = opts.restoreTabAfterInput
  }
}

export function isInsideInputFocus(): boolean {
  return inputFocusDepth > 0
}

function cancelPendingRestore(): void {
  if (restoreTimer) {
    clearTimeout(restoreTimer)
    restoreTimer = null
  }
}

/** Immediately restore the user's tab (session end, Take Control, etc.). */
export async function flushTabRestore(): Promise<void> {
  cancelPendingRestore()
  if (!pendingRestore) return
  const { backend, userTab, agentTab } = pendingRestore
  pendingRestore = null
  await restoreUserTab(backend, userTab, agentTab)
}

function scheduleRestore(
  backend: BrowserBackend,
  userTab: string | null,
  agentTab: string,
): void {
  if (!restoreTabAfterInput || !userTab || userTab === agentTab) return
  pendingRestore = { backend, userTab, agentTab }
  cancelPendingRestore()
  restoreTimer = setTimeout(() => {
    restoreTimer = null
    const pending = pendingRestore
    pendingRestore = null
    if (!pending) return
    void restoreUserTab(pending.backend, pending.userTab, pending.agentTab)
  }, RESTORE_DEBOUNCE_MS)
  restoreTimer.unref?.()
}

export async function getActiveUserTabId(
  backend: BrowserBackend,
): Promise<string | null> {
  return backend.getActiveUserTabId()
}

export async function ensureTabFocus(
  backend: BrowserBackend,
  targetId: string,
  level: FocusLevel,
): Promise<void> {
  // Silent extension: never request window-level focus.
  const effective = backend.kind === 'extension' ? 'tab' : level
  await backend.focusTab(targetId, effective)
}

export async function restoreUserTab(
  backend: BrowserBackend,
  userTabId: string | null,
  agentTabId: string,
): Promise<void> {
  if (!userTabId || userTabId === agentTabId) return
  if (!restoreTabAfterInput) return
  await backend.restoreTab(userTabId)
}

/** Screenshots need Chrome to paint the tab, which a background tab may not. */
export async function withVisualFocus<T>(
  backend: BrowserBackend,
  targetId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withInputFocus(backend, targetId, fn)
}

/** L0 — no tab or window changes (extension reads stay in the background). */
export async function withReadBoost<T>(
  backend: BrowserBackend,
  targetId: string,
  fn: () => Promise<T>,
): Promise<T> {
  void backend
  void targetId
  return fn()
}

/**
 * A minimized or fully occluded Chrome window produces no frames, so
 * Page.captureScreenshot and Playwright's actionability waits hang until
 * their outer timeout instead of failing.
 */
async function isRendering(page: Page): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const frame = page
    .evaluate(
      () =>
        new Promise<boolean>(resolve =>
          requestAnimationFrame(() => resolve(true)),
        ),
    )
    .catch(() => true)
  const timeout = new Promise<boolean>(resolve => {
    timer = setTimeout(() => resolve(false), RENDER_PROBE_MS)
  })
  try {
    return await Promise.race([frame, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** L1 tab strip only before input; optional debounced restore if configured. */
export async function withInputFocus<T>(
  backend: BrowserBackend,
  targetId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const userTab =
    backend.kind === 'extension' ? await getActiveUserTabId(backend) : null
  inputFocusDepth++
  try {
    if (backend.kind === 'extension') {
      cancelPendingRestore()
      const active = await getActiveUserTabId(backend)
      if (active !== targetId) {
        await ensureTabFocus(backend, targetId, 'tab')
      }
      const page = await getPageForTarget(backend, targetId)
      if (!(await isRendering(page))) {
        throw new BrowserError(NOT_RENDERING_MESSAGE)
      }
    }
    return await fn()
  } finally {
    inputFocusDepth--
    if (backend.kind === 'extension') {
      scheduleRestore(backend, userTab, targetId)
    }
  }
}
