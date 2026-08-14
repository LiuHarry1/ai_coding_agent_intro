/**
 * Filter active tools by session permission mode.
 */
import type { AnyTool } from './types.js'
import type { ExternalMode } from './permission-mode.js'
import {
  READ_ONLY_TOOLS,
  PLAN_MODE_DENIED_TOOLS,
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_NAME,
} from '../constants/tool_names.js'

function omitTools(
  tools: Record<string, AnyTool>,
  denied: Set<string>,
): Record<string, AnyTool> {
  const result: Record<string, AnyTool> = {}
  for (const [name, tool] of Object.entries(tools)) {
    if (!denied.has(name)) result[name] = tool
  }
  return result
}

function pickTools(
  tools: Record<string, AnyTool>,
  allowed: readonly string[],
): Record<string, AnyTool> {
  const allowSet = new Set(allowed)
  const result: Record<string, AnyTool> = {}
  for (const name of allowed) {
    if (tools[name]) result[name] = tools[name]
  }
  // Include MCP tools that match read-only patterns when explicitly allowed
  for (const [name, tool] of Object.entries(tools)) {
    if (!result[name] && allowSet.has(name)) result[name] = tool
  }
  return result
}

export function applyModeRestrictions(
  mode: ExternalMode,
  tools: Record<string, AnyTool>,
  extra?: Record<string, AnyTool>,
): Record<string, AnyTool> {
  const merged = { ...tools, ...extra }

  switch (mode) {
    case 'ask': {
      // Read-only only. Do NOT re-add ToolSearch — discovering deferred
      // write/shell/MCP tools would bypass this filter mid-turn
      // (activateDeferredTools mutates activeTools directly).
      return pickTools(merged, [...READ_ONLY_TOOLS])
    }
    case 'plan': {
      const denied = new Set([
        ...PLAN_MODE_DENIED_TOOLS,
        ENTER_PLAN_MODE_TOOL_NAME,
      ])
      const filtered = omitTools(merged, denied)
      // Ensure ExitPlanMode and AskUserQuestion are present
      if (extra?.[EXIT_PLAN_MODE_TOOL_NAME]) {
        filtered[EXIT_PLAN_MODE_TOOL_NAME] = extra[EXIT_PLAN_MODE_TOOL_NAME]
      }
      if (merged[ASK_USER_QUESTION_TOOL_NAME]) {
        filtered[ASK_USER_QUESTION_TOOL_NAME] =
          merged[ASK_USER_QUESTION_TOOL_NAME]
      }
      return filtered
    }
    case 'agent':
    default: {
      const filtered = { ...merged }
      delete filtered[EXIT_PLAN_MODE_TOOL_NAME]
      if (extra?.[ENTER_PLAN_MODE_TOOL_NAME]) {
        filtered[ENTER_PLAN_MODE_TOOL_NAME] = extra[ENTER_PLAN_MODE_TOOL_NAME]
      }
      return filtered
    }
  }
}

export function getAskModeToolNames(): readonly string[] {
  return READ_ONLY_TOOLS
}
