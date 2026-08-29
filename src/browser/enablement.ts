/**
 * When browser_* tools are available on the main thread (CC-style opt-in).
 *
 * - `browser` primary agent → always on (eager load in assembleToolPool)
 * - everyone else → off unless `browser.enabled: true` (deferred + ToolSearch)
 */
import {
  BASH_TOOL_NAME,
  BROWSER_TOOL_NAMES,
  FILE_READ_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  SKILL_TOOL_NAME,
} from '../constants/tool_names.js'
import type { BrowserConfig } from './types.js'

export const BROWSER_AGENT_TYPE = 'browser'
export const BROWSER_TOOLS_DENY_GLOB = 'browser_*'

/** Full browser_* set for the Browser Automation primary agent (see `.ai-agent/agents/browser.md`). */
export const BROWSER_AGENT_BROWSER_TOOLS: readonly string[] = [
  ...BROWSER_TOOL_NAMES,
]

/** Non-browser helpers kept on the browser primary profile. */
export const BROWSER_AGENT_SUPPORT_TOOLS: readonly string[] = [
  BASH_TOOL_NAME,
  SKILL_TOOL_NAME,
  FILE_READ_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
]

export const BROWSER_AGENT_TOOLS: readonly string[] = [
  ...BROWSER_AGENT_BROWSER_TOOLS,
  ...BROWSER_AGENT_SUPPORT_TOOLS,
]

export function isBrowserEnabledForMainThread(
  agentType: string | null | undefined,
  browser?: BrowserConfig,
): boolean {
  if (agentType === BROWSER_AGENT_TYPE) return true
  return browser?.enabled === true
}

/** Deny glob to apply when browser is disabled for this main-thread agent. */
export function browserDenyGlobsForMainThread(
  agentType: string | null | undefined,
  browser?: BrowserConfig,
): string[] {
  if (isBrowserEnabledForMainThread(agentType, browser)) return []
  return [BROWSER_TOOLS_DENY_GLOB]
}
