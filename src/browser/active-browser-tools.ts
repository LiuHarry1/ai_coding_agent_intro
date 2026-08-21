/**
 * Track in-flight browser_* tool invocations so Pause (user has control) can
 * abort only the calls that would be blocked — clearing stuck UI spinners
 * without killing Bash or other non-browser work.
 */

import {
  BROWSER_CONSOLE_TOOL_NAME,
  BROWSER_EVALUATE_TOOL_NAME,
  BROWSER_LOCK_TOOL_NAME,
  BROWSER_NETWORK_TOOL_NAME,
  BROWSER_SCREENSHOT_TOOL_NAME,
  BROWSER_SNAPSHOT_TOOL_NAME,
  BROWSER_TABS_TOOL_NAME,
  BROWSER_WAIT_FOR_TOOL_NAME,
} from '../constants/tool_names.js'
import { abortTool } from '../core/tool-abort-registry.js'

/** Read-only / handoff tools allowed while the user has the page. */
const USER_CONTROL_ALLOWED = new Set([
  BROWSER_LOCK_TOOL_NAME,
  BROWSER_SNAPSHOT_TOOL_NAME,
  BROWSER_SCREENSHOT_TOOL_NAME,
  BROWSER_CONSOLE_TOOL_NAME,
  BROWSER_NETWORK_TOOL_NAME,
  BROWSER_TABS_TOOL_NAME,
  BROWSER_EVALUATE_TOOL_NAME,
  BROWSER_WAIT_FOR_TOOL_NAME,
])

/**
 * True when Pause should abort an in-flight call of this tool/args.
 * Mirrors assertAgentMayAct in BrowserTool (tabs list stays allowed).
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
 * mutate the page (same policy as assertAgentMayAct).
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
