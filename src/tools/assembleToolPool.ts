/**
 * Assemble the active / deferred / mode tool pool for one turn.
 * Built-ins + MCP live on the registry; Agent/Skill must be registered first.
 */
import { filterToolsByEnablement } from '../core/tool-enablement.js'
import { createToolSearchDefinition } from './ToolSearchTool/ToolSearchTool.js'
import {
  BROWSER_TOOL_NAMES,
  READ_ONLY_TOOLS,
  TOOL_SEARCH_TOOL_NAME,
} from '../constants/tool_names.js'
import { applyModeRestrictions } from '../core/mode-restrictions.js'
import { definition as enterPlanModeDef } from './EnterPlanModeTool/EnterPlanModeTool.js'
import { definition as exitPlanModeDef } from './ExitPlanModeTool/ExitPlanModeTool.js'
import { findPrimaryAgent } from './AgentTool/mergeAgents.js'
import {
  filterDeferredDefsByDisallowedGlobs,
  filterToolsRecordByDisallowedGlobs,
} from './AgentTool/toolGlob.js'
import type {
  AgentDefinition,
  AnyTool,
  Session,
  ToolContext,
  ToolDefinition,
} from '../core/types.js'
import type { ToolRegistry } from '../core/tool-registry.js'
import type { ToolEnablementSource } from '../core/tool-enablement.js'

export interface AssembleToolPoolInput {
  registry: ToolRegistry
  cwd: string
  session: Session
  toolContext: ToolContext
  mcpTools: Record<string, AnyTool>
  activeAgents: AgentDefinition[]
  toolEnablement: ToolEnablementSource
}

export interface AssembleToolPoolResult {
  tools: Record<string, AnyTool>
  /** Tools before mode filtering -- used to refresh when mode changes mid-turn. */
  baseTools: Record<string, AnyTool>
  modeTools: Record<string, AnyTool>
  deferredToolPool?: Record<string, AnyTool>
  deferredDefs: Array<{ name: string; description: string; isMcp: boolean }>
  /**
   * Definitions built per turn instead of living on the registry (ToolSearch).
   * The executor needs them to reach `mapToolResultToToolResultBlockParam` /
   * `outputSchema`; a registry lookup alone would miss them.
   */
  dynamicDefs: Record<string, ToolDefinition>
  mainThreadProfile: AgentDefinition | null
  /** Re-applied after mid-turn mode refresh so ExitPlanMode cannot sneak back. */
  denyGlobs: string[] | undefined
}

export function assembleToolPool(
  input: AssembleToolPoolInput,
): AssembleToolPoolResult {
  const {
    registry,
    cwd,
    session,
    toolContext,
    mcpTools,
    activeAgents,
    toolEnablement,
  } = input

  let { active, deferred, deferredDefs } = registry.createSplit(
    cwd,
    toolContext,
    mcpTools,
    session.discoveredTools,
  )

  // Primary-profile disallowedTools (globs ok) on the main thread.
  // Applied in every permission mode so plan/ask cannot revive Edit/Write.
  const mainThreadProfile = findPrimaryAgent(activeAgents, session.agentType)
  const denyGlobs = mainThreadProfile?.disallowedTools
  if (denyGlobs && denyGlobs.length > 0) {
    active = filterToolsRecordByDisallowedGlobs(active, denyGlobs)
    deferred = filterToolsRecordByDisallowedGlobs(deferred, denyGlobs)
    deferredDefs = filterDeferredDefsByDisallowedGlobs(deferredDefs, denyGlobs)
    console.log(
      `[server] agentType=${mainThreadProfile!.agentType} denied globs=[${denyGlobs.join(', ')}]`,
    )
  }

  // Browser specialist: these tools are the job, not a deferred lookup.
  // Qwen (and others) call ToolSearch in parallel with browser_* and the
  // sibling calls fail because activation only happens on the next step.
  if (mainThreadProfile?.agentType === 'browser') {
    for (const name of BROWSER_TOOL_NAMES) {
      if (deferred[name]) {
        active[name] = deferred[name]!
        delete deferred[name]
      }
    }
    deferredDefs = deferredDefs.filter(d => deferred[d.name])
  }

  const dynamicDefs: Record<string, ToolDefinition> = {}
  if (deferredDefs.length > 0 && session.permissionMode.mode !== 'ask') {
    const tsearchDef = createToolSearchDefinition(deferredDefs)
    active[TOOL_SEARCH_TOOL_NAME] = tsearchDef.create(cwd, toolContext)
    dynamicDefs[TOOL_SEARCH_TOOL_NAME] = tsearchDef
  }

  const enablementFiltered = filterToolsByEnablement(
    active,
    registry,
    toolEnablement,
  )

  const modeTools: Record<string, AnyTool> = {
    [enterPlanModeDef.name]: enterPlanModeDef.create(cwd, toolContext),
    [exitPlanModeDef.name]: exitPlanModeDef.create(cwd, toolContext),
  }

  // Ask mode: promote read-only deferred tools (LSP/WebSearch/…) into the
  // active set. Do not expose ToolSearch or mutating/MCP deferred tools.
  if (session.permissionMode.mode === 'ask') {
    const readOnly = new Set<string>(READ_ONLY_TOOLS)
    for (const name of READ_ONLY_TOOLS) {
      if (deferred[name] && !enablementFiltered[name]) {
        enablementFiltered[name] = deferred[name]!
      }
    }
    for (const name of Object.keys(deferred)) {
      if (!readOnly.has(name)) delete deferred[name]
    }
    // No ToolSearch in ask — mutating deferred tools stay withheld.
  }

  let tools = applyModeRestrictions(
    session.permissionMode.mode,
    enablementFiltered,
    modeTools,
  )
  if (denyGlobs && denyGlobs.length > 0) {
    tools = filterToolsRecordByDisallowedGlobs(tools, denyGlobs)
  }

  const askMode = session.permissionMode.mode === 'ask'
  const deferredForTurn = askMode ? {} : deferred
  const deferredDefsForTurn = askMode
    ? []
    : deferredDefs.filter(d => deferred[d.name])

  return {
    tools,
    baseTools: enablementFiltered,
    modeTools,
    deferredToolPool:
      Object.keys(deferredForTurn).length > 0 ? deferredForTurn : undefined,
    deferredDefs: deferredDefsForTurn,
    dynamicDefs,
    mainThreadProfile,
    denyGlobs,
  }
}
