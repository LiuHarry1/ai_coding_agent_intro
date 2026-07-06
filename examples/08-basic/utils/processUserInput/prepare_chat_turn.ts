/**
 * Prepare a chat turn before runAgent — processUserInput pipeline.
 * Slash resolution, per-request registry reload, tools, mode restrictions.
 * Attachments collected in agent loop via getAttachmentMessages.
 */
import { dispatchSlashCommand } from '../../commands/dispatcher.js'
import { resolvePlanSlash } from '../../commands/plan.js'
import {
  registerSubagents,
  getSubagentNames,
} from '../../tools/AgentTool/index.js'
import { registerSkills, formatSkillListing } from '../../skills/index.js'
import {
  loadPlugins,
  pluginErrorMessage,
  pluginErrorSource,
} from '../../core/plugins/index.js'
import { loadProjectRules } from '../rules-loader.js'
import { filterToolsByEnablement } from '../../core/tool-enablement.js'
import { buildConcurrencyPolicy } from '../../core/concurrency-policy.js'
import { createToolSearchDefinition } from '../../tools/tool_search.js'
import { TOOL_SEARCH_TOOL_NAME } from '../../constants/tool_names.js'
import { applyModeRestrictions } from '../../core/mode-restrictions.js'
import { definition as enterPlanModeDef } from '../../tools/enter_plan_mode.js'
import { definition as exitPlanModeDef } from '../../tools/exit_plan_mode.js'
import { getPlanFilePath } from '../plans.js'
import type { ReadFileState } from '../attachments/types.js'
import type {
  AnyTool,
  IProvider,
  IToolRegistry,
  Session,
  ToolContext,
  ToolUseContext,
  AppConfig,
} from '../../core/types.js'
import type { ToolRegistry } from '../../core/tool-registry.js'
import type { SlashEntry } from '../../commands/slashRegistry.js'
import { extractFilePathCandidates } from './path_candidates.js'
import { mergeMCPServers } from '../../core/settings-manager.js'
import { noopWireEmitter } from '../../core/wire-emitter.js'
import { getMCPManagerForServers } from '../../server/mcp-lifecycle.js'

export type ForkSkillSlashResult = {
  kind: 'run'
  mode: 'fork'
  text: string
  entry: Extract<SlashEntry, { kind: 'skill' }>
}

export interface SlashResolution {
  effectiveMessage: string
  immediateReply: string | null
  forkSkill: ForkSkillSlashResult | null
  /** Set when the user ran `/compact [instructions]`; handled by the chat route. */
  manualCompact: { instructions: string } | null
  modeChanged?: boolean
}

export async function resolveSlashCommand(
  message: string,
  cwd: string,
  session?: Session,
): Promise<SlashResolution> {
  if (session) {
    const planSlash = resolvePlanSlash(message, session, cwd)
    if (planSlash.handled) {
      return {
        effectiveMessage: planSlash.effectiveMessage ?? message,
        immediateReply: planSlash.immediateReply ?? null,
        forkSkill: null,
        manualCompact: null,
        modeChanged: planSlash.modeChanged,
      }
    }
  }

  const slashResult = await dispatchSlashCommand(message, { cwd })
  let effectiveMessage = message
  let immediateReply: string | null = null
  let forkSkill: SlashResolution['forkSkill'] = null
  let manualCompact: SlashResolution['manualCompact'] = null

  if (slashResult.kind === 'reply') {
    immediateReply = slashResult.text
  } else if (slashResult.kind === 'compact') {
    manualCompact = { instructions: slashResult.instructions }
  } else if (slashResult.kind === 'unknown') {
    immediateReply = `Unknown slash command: /${slashResult.name}\n\nTry /help to see all available commands.`
  } else if (slashResult.kind === 'run' && slashResult.mode === 'inline') {
    effectiveMessage = slashResult.text
    console.log(
      `[server] expanded /${slashResult.entry.name} (${slashResult.entry.kind}) → ${effectiveMessage.length} char prompt`,
    )
  } else if (
    slashResult.kind === 'run' &&
    slashResult.mode === 'fork' &&
    slashResult.entry.kind === 'skill'
  ) {
    forkSkill = slashResult as ForkSkillSlashResult
  }

  return { effectiveMessage, immediateReply, forkSkill, manualCompact }
}

export interface PreparedChatTurn {
  effectiveMessage: string
  immediateReply: string | null
  forkSkill: SlashResolution['forkSkill']
  manualCompact: SlashResolution['manualCompact']
  tools: Record<string, AnyTool>
  /** Tools before mode filtering — used to refresh when mode changes mid-turn. */
  baseTools: Record<string, AnyTool>
  modeTools: Record<string, AnyTool>
  deferredToolPool?: Record<string, AnyTool>
  projectRules: string
  toolUseContext: ToolUseContext
  subagentNames: Set<string>
  concurrencyPolicy: ReturnType<typeof buildConcurrencyPolicy>
  permissionMode: Session['permissionMode']['mode']
  planFilePath: string
  modeChanged?: boolean
  toolContext: ToolContext
}

export interface PrepareChatTurnInput {
  message: string
  cwd: string
  session: Session
  registry: IToolRegistry
  config: AppConfig
  provider: IProvider
  eventBus: ToolContext['eventBus']
  middleware: ToolContext['middleware']
  runAgent: NonNullable<ToolContext['runAgent']>
}

export async function prepareChatTurn(
  input: PrepareChatTurnInput,
): Promise<PreparedChatTurn> {
  const {
    message,
    cwd,
    session,
    registry,
    config,
    provider,
    eventBus,
    middleware,
    runAgent,
  } = input

  const slash = await resolveSlashCommand(message, cwd, session)

  const plugins = await loadPlugins(cwd)
  if (plugins.plugins.length > 0) {
    console.log(
      `[server] plugins=[${plugins.plugins.map(p => p.name).join(', ')}] ` +
        `(+${plugins.agentFiles.length} agents, ${plugins.skills.length} skills, ` +
        `${Object.keys(plugins.mcpServers).length} mcp)`,
    )
  }
  for (const e of plugins.errors) {
    console.warn(`[plugins] ${pluginErrorSource(e)}: ${pluginErrorMessage(e)}`)
  }
  const mcpServers = mergeMCPServers(plugins.mcpServers, config.mcpServers)
  const mcpManager = await getMCPManagerForServers(cwd, mcpServers)

  const { activeAgents } = await registerSubagents(
    registry,
    cwd,
    plugins.agentFiles,
  )
  const candidateFiles = extractFilePathCandidates(slash.effectiveMessage)
  const { activeSkills, allSkills } = await registerSkills(
    registry,
    cwd,
    activeAgents,
    { candidateFiles, pluginSkills: plugins.skills },
  )
  const conditionalHidden = allSkills.length - activeSkills.length
  console.log(
    `[server] cwd=${cwd}  agents=[${activeAgents.map(a => a.agentType).join(', ')}]  skills=[${activeSkills.map(s => s.name).join(', ')}]${conditionalHidden > 0 ? `  (+${conditionalHidden} conditional hidden)` : ''}`,
  )

  const projectRules = loadProjectRules(cwd)
  const toolEnablement = { disabledTools: config.disabledTools }

  const toolContext: ToolContext = {
    eventBus,
    wire: noopWireEmitter,
    middleware,
    runAgent,
    registry,
    mcpTools: mcpManager.getAllTools(),
    toolEnablement,
    provider,
    compaction: config.compaction,
    lspServers: config.lspServers,
    sessionId: session.id,
    session,
    cwd,
  }

  const { active, deferred, deferredDefs } = (
    registry as ToolRegistry
  ).createSplit(
    cwd,
    toolContext,
    mcpManager.getAllTools(),
    session.discoveredTools,
  )

  if (deferredDefs.length > 0) {
    const tsearchDef = createToolSearchDefinition(deferredDefs)
    active[TOOL_SEARCH_TOOL_NAME] = tsearchDef.create(cwd, toolContext)
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

  const tools = applyModeRestrictions(
    session.permissionMode.mode,
    enablementFiltered,
    modeTools,
  )

  const reminderParts: string[] = []
  if (activeSkills.length > 0) {
    reminderParts.push(
      `The following skills are available for use with the skill tool:\n\n${formatSkillListing(activeSkills)}`,
    )
  }
  if (deferredDefs.length > 0) {
    const listing = deferredDefs
      .map(
        (d: { name: string; description: string; isMcp: boolean }) =>
          `- ${d.name}${d.isMcp ? ' (MCP)' : ''}`,
      )
      .join('\n')
    reminderParts.push(
      `The following tools are available but not loaded. Use \`${TOOL_SEARCH_TOOL_NAME}\` to discover and load them before use:\n${listing}`,
    )
  }

  console.log(
    `[server] mode=${session.permissionMode.mode} tools: ${Object.keys(tools).length} active, ${deferredDefs.length} deferred${session.discoveredTools?.size ? `, ${session.discoveredTools.size} previously discovered` : ''}`,
  )

  if (!session.readFileState) {
    session.readFileState = new Map()
  }
  const readFileState = session.readFileState as ReadFileState

  const toolUseContext: ToolUseContext = {
    cwd,
    session,
    readFileState,
    lspServers: config.lspServers,
    options: { tools },
    skillListingContent:
      reminderParts.length > 0 ? reminderParts.join('\n\n') : undefined,
    agentDefinitions: { activeAgents },
  }

  const planFilePath = getPlanFilePath(session, cwd)

  return {
    effectiveMessage: slash.effectiveMessage,
    immediateReply: slash.immediateReply,
    forkSkill: slash.forkSkill,
    manualCompact: slash.manualCompact,
    tools,
    baseTools: enablementFiltered,
    modeTools,
    deferredToolPool: Object.keys(deferred).length > 0 ? deferred : undefined,
    projectRules,
    toolUseContext,
    subagentNames: getSubagentNames(registry),
    concurrencyPolicy: buildConcurrencyPolicy(registry, Object.keys(tools)),
    permissionMode: session.permissionMode.mode,
    planFilePath,
    modeChanged: slash.modeChanged,
    toolContext,
  }
}
