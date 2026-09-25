/**
 * Track in-flight browser_* tool invocations so Pause (user has control) can
 * abort only the calls that would be blocked — clearing stuck UI spinners
 * without killing Bash or other non-browser work.
 *
 * The allow-list here is the single source of truth for both Pause abort and
 * assertAgentMayAct (new calls while the user has the page).
 */

import {
  BROWSER_CONSOLE_TOOL_NAME,
  BROWSER_GET_BOUNDING_BOX_TOOL_NAME,
  BROWSER_GET_TEXT_TOOL_NAME,
  BROWSER_HIGHLIGHT_TOOL_NAME,
  BROWSER_LOCK_TOOL_NAME,
  BROWSER_NETWORK_TOOL_NAME,
  BROWSER_SCREENSHOT_TOOL_NAME,
  BROWSER_SNAPSHOT_TOOL_NAME,
  BROWSER_TABS_TOOL_NAME,
  BROWSER_WAIT_FOR_TOOL_NAME,
} from '../constants/tool_names.js'
import { abortTool } from '../core/tool-abort-registry.js'
import { BrowserError } from './types.js'

/**
 * Read-only / handoff tools allowed while the user has the page.
 * Mutating tools (click, type, navigate, …) are blocked and aborted on Pause.
 */
const USER_CONTROL_ALLOWED = new Set([
  BROWSER_LOCK_TOOL_NAME,
  BROWSER_SNAPSHOT_TOOL_NAME,
  BROWSER_GET_TEXT_TOOL_NAME,
  BROWSER_SCREENSHOT_TOOL_NAME,
  BROWSER_CONSOLE_TOOL_NAME,
  BROWSER_NETWORK_TOOL_NAME,
  BROWSER_TABS_TOOL_NAME,
  BROWSER_WAIT_FOR_TOOL_NAME,
  BROWSER_HIGHLIGHT_TOOL_NAME,
  BROWSER_GET_BOUNDING_BOX_TOOL_NAME,
])

/**
 * True when Pause should abort an in-flight call, or when a new call must be
 * rejected while the user has control. `browser_tabs` action `list` stays allowed.
 */
export function isBrowserToolBlockedByUserControl(
  toolName: string,
  args: unknown,
): boolean {
  if (toolName === BROWSER_TABS_TOOL_NAME) {
    const action = (args as { action?: string } | undefined)?.action
    return Boolean(action && action !== 'list')
  }
  return !USER_CONTROL_ALLOWED.has(toolName)
}

const USER_CONTROL_RECOVERY =
  '\nRecovery action: stop and wait for the user to say they are done, then browser_lock with action "lock"'

/** Reject a new tool call while the user has control (same set as Pause abort). */
export function assertBrowserAgentMayAct(
  toolName: string,
  args: unknown,
): void {
  if (!isBrowserToolBlockedByUserControl(toolName, args)) return
  if (toolName === BROWSER_TABS_TOOL_NAME) {
    throw new BrowserError(
      'The user has control of the browser. Only browser_tabs action "list" is allowed until you call browser_lock with action "lock".' +
        USER_CONTROL_RECOVERY,
    )
  }
  throw new BrowserError(
    'The user has control of the browser. Call browser_lock with action "lock" after they finish, then continue. Do not click or type while they are using it.' +
      USER_CONTROL_RECOVERY,
  )
}

export type ActiveBrowserTool = {
  toolUseId: string
  toolName: string
  args: unknown
}

const bySession = new Map<string, Map<string, ActiveBrowserTool>>()

function sessionMap(sessionId: string): Map<string, ActiveBrowserTool> {
  let m = bySession.get(sessionId)
  if (!m) {
    m = new Map()
    bySession.set(sessionId, m)
  }
  return m
}

export function trackActiveBrowserTool(
  sessionId: string | undefined,
  toolUseId: string,
  toolName: string,
  args: unknown,
): void {
  if (!sessionId || !toolUseId) return
  sessionMap(sessionId).set(toolUseId, { toolUseId, toolName, args })
}

export function untrackActiveBrowserTool(
  sessionId: string | undefined,
  toolUseId: string,
): void {
  if (!sessionId || !toolUseId) return
  const m = bySession.get(sessionId)
  if (!m) return
  m.delete(toolUseId)
  if (m.size === 0) bySession.delete(sessionId)
}

function abortSessionBlocked(sessionId: string): number {
  const m = bySession.get(sessionId)
  if (!m) return 0
  let n = 0
  for (const { toolUseId, toolName, args } of m.values()) {
    if (!isBrowserToolBlockedByUserControl(toolName, args)) continue
    if (abortTool(sessionId, toolUseId)) n++
  }
  return n
}

/**
 * Called when the user takes control. Aborts in-flight browser tools that
 * mutate the page (same policy as assertBrowserAgentMayAct).
 */
export function abortBlockedBrowserTools(sessionId: string | undefined): number {
  if (!sessionId) return 0
  return abortSessionBlocked(sessionId)
}

/** Extension / global Pause — abort blocked tools in every tracked session. */
export function abortBlockedBrowserToolsEverywhere(): number {
  let n = 0
  for (const sessionId of bySession.keys()) {
    n += abortSessionBlocked(sessionId)
  }
  return n
}
