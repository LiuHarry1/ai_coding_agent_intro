/**
 * Prepare a chat turn before runAgent -- processUserInput pipeline.
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
import { loadAllAgentRules } from '../rules-loader.js'
import { buildConcurrencyPolicy } from '../../core/concurrency-policy.js'
import { TOOL_SEARCH_TOOL_NAME } from '../../constants/tool_names.js'
import { getPlanFilePath } from '../plans.js'
import type { ReadFileState } from '../read/types.js'
import { getDefaultWorkspace } from '../../core/workspace.js'
import {
  isRemoteWorkspace,
  resolveExecutionBackend,
} from '../../execution/index.js'
import type {
  AgentDefinition,
  AnyTool,
  IProvider,
  IToolRegistry,
  Session,
  ToolContext,
  ToolDefinition,
  ToolUseContext,
  AppConfig,
} from '../../core/types.js'
import type { ToolRegistry } from '../../core/tool-registry.js'
import type { SlashEntry } from '../../commands/slashRegistry.js'
import { extractFilePathCandidates } from './path_candidates.js'
import { mergeMCPServers } from '../../core/settings-manager.js'
import { noopWireEmitter } from '../../core/wire-emitter.js'
import { getMCPManagerForServers } from '../../core/mcp-lifecycle.js'
import { createSandboxPolicy } from '../../core/sandbox.js'
import { resolveAutoMemoryConfig } from '../../core/settings-manager.js'
import {
  buildAutoMemorySystemAppend,
  getAutoMemPath,
} from '../../services/auto-memory/index.js'
import { assembleToolPool } from '../../tools/assembleToolPool.js'
import {
  isBrowserEnabledForMainThread,
} from '../../browser/enablement.js'
import { warmExtensionRelay } from '../../browser/manager.js'
import { profileSpan } from '../startupProfiler.js'

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
  /** Set when the user ran `/summary`; force session-memory extract. */
  forceSummary: boolean
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
        forceSummary: false,
        modeChanged: planSlash.modeChanged,
      }
    }
  }

  const slashResult = await dispatchSlashCommand(message, { cwd })
  let effectiveMessage = message
  let immediateReply: string | null = null
  let forkSkill: SlashResolution['forkSkill'] = null
  let manualCompact: SlashResolution['manualCompact'] = null
  let forceSummary = false

  if (slashResult.kind === 'reply') {
    immediateReply = slashResult.text
  } else if (slashResult.kind === 'compact') {
    manualCompact = { instructions: slashResult.instructions }
  } else if (slashResult.kind === 'summary') {
    forceSummary = true
  } else if (slashResult.kind === 'unknown') {
    immediateReply = `Unknown slash command: /${slashResult.name}\n\nTry /help to see all available commands.`
  } else if (slashResult.kind === 'run' && slashResult.mode === 'inline') {
    effectiveMessage = slashResult.text
    console.log(
      `[server] expanded /${slashResult.entry.name} (${slashResult.entry.kind}) -> ${effectiveMessage.length} char prompt`,
    )
  } else if (
    slashResult.kind === 'run' &&
    slashResult.mode === 'fork' &&
    slashResult.entry.kind === 'skill'
  ) {
    forkSkill = slashResult as ForkSkillSlashResult
  }

  return { effectiveMessage, immediateReply, forkSkill, manualCompact, forceSummary }
}

export interface PreparedChatTurn {
  effectiveMessage: string
  immediateReply: string | null
  forkSkill: SlashResolution['forkSkill']
  manualCompact: SlashResolution['manualCompact']
  forceSummary: boolean
  tools: Record<string, AnyTool>
  /** Tools before mode filtering -- used to refresh when mode changes mid-turn. */
  baseTools: Record<string, AnyTool>
  modeTools: Record<string, AnyTool>
  deferredToolPool?: Record<string, AnyTool>
  /** Per-turn dynamic defs first, then the registry. */
  getToolDefinition: (name: string) => ToolDefinition | undefined
  projectRules: string
  toolUseContext: ToolUseContext
  subagentNames: Set<string>
  concurrencyPolicy: ReturnType<typeof buildConcurrencyPolicy>
  permissionMode: Session['permissionMode']['mode']
  /** Resolved primary profile for this turn, if any. */
  mainThreadProfile: AgentDefinition | null
  denyGlobs?: string[]
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
  models?: ToolContext['models']
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
    models,
    eventBus,
    middleware,
    runAgent,
  } = input

  const slash = await resolveSlashCommand(message, cwd, session)

  // Plugins/skills/MCP load from a local tree. Remote sessions still use the
  // Control Plane machine's default workspace for that — tools use remote cwd.
  const remote = isRemoteWorkspace(session.workspace)
  const pluginCwd = remote ? getDefaultWorkspace() : cwd

  const plugins = await loadPlugins(pluginCwd)
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
  const mcpManager = await getMCPManagerForServers(pluginCwd, mcpServers)

  const { activeAgents } = await registerSubagents(
    registry,
    pluginCwd,
    plugins.agentFiles,
  )
  const candidateFiles = extractFilePathCandidates(slash.effectiveMessage)
  const { activeSkills, allSkills } = await registerSkills(
    registry,
    pluginCwd,
    activeAgents,
    { candidateFiles, pluginSkills: plugins.skills },
  )
  const conditionalHidden = allSkills.length - activeSkills.length
  console.log(
    `[server] cwd=${cwd}${remote ? ` remote=${session.workspace?.environmentId}` : ''}  agents=[${activeAgents.map(a => a.agentType).join(', ')}]  skills=[${activeSkills.map(s => s.name).join(', ')}]${conditionalHidden > 0 ? `  (+${conditionalHidden} conditional hidden)` : ''}`,
  )

  const projectRulesRaw = remote ? '' : loadAllAgentRules(cwd)
  const autoMemory = resolveAutoMemoryConfig(config)
  const autoMemoryAppend = buildAutoMemorySystemAppend({
    cwd: pluginCwd,
    config: autoMemory,
  })
  const projectRules = [projectRulesRaw, autoMemoryAppend]
    .filter(s => s.trim())
    .join('\n\n')
  const toolEnablement = {
    disabledTools: [
      ...(config.disabledTools ?? []),
      // PowerShell is host-local; remote SSH always uses bash.
      ...(remote ? ['powershell'] : []),
    ],
  }

  const autoMemEnabled = autoMemory.enabled && !remote
  const autoMemPath = autoMemEnabled
    ? getAutoMemPath({
        cwd: pluginCwd,
        trustedDirectory: autoMemory.directory,
      })
    : undefined

  let execution
  try {
    execution = await profileSpan('turn_execution_backend', () =>
      resolveExecutionBackend(session, config.lspServers),
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[server] execution backend resolve failed:`, msg)
    if (remote) {
      throw new Error(
        `Remote execution backend unavailable (${session.workspace?.environmentId}): ${msg}. ` +
          `Shell/file tools cannot fall back to the local machine.`,
      )
    }
    execution = undefined
  }

  const toolContext: ToolContext = {
    eventBus,
    wire: noopWireEmitter,
    middleware,
    runAgent,
    registry,
    mcpTools: mcpManager.getAllTools(),
    toolEnablement,
    provider,
    models,
    compaction: config.compaction,
    sessionMemory: config.sessionMemory,
    lspServers: config.lspServers,
    sessionId: session.id,
    session,
    cwd,
    sandbox: createSandboxPolicy(
      remote ? pluginCwd : cwd,
      autoMemPath
        ? {
            extraReadRoots: [autoMemPath],
            extraWriteRoots: [autoMemPath],
          }
        : undefined,
    ),
    execution,
  }

  const pool = assembleToolPool({
    registry: registry as ToolRegistry,
    cwd,
    session,
    toolContext,
    mcpTools: mcpManager.getAllTools(),
    activeAgents,
    toolEnablement,
    browserConfig: config.browser,
  })

  if (
    isBrowserEnabledForMainThread(
      pool.mainThreadProfile?.agentType ?? session.agentType,
      config.browser,
    ) &&
    config.browser?.mode === 'extension'
  ) {
    warmExtensionRelay(cwd)
  }

  const reminderParts: string[] = []
  if (activeSkills.length > 0) {
    reminderParts.push(
      `The following skills are available for use with the skill tool:\n\n${formatSkillListing(activeSkills)}`,
    )
  }
  if (pool.deferredDefs.length > 0) {
    const listing = pool.deferredDefs
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
    `[server] mode=${session.permissionMode.mode}${pool.mainThreadProfile ? ` agentType=${pool.mainThreadProfile.agentType}` : ''} tools: ${Object.keys(pool.tools).length} active, ${pool.deferredDefs.length} deferred${session.discoveredTools?.size ? `, ${session.discoveredTools.size} previously discovered` : ''}`,
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
    options: { tools: pool.tools },
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
    forceSummary: slash.forceSummary,
    tools: pool.tools,
    baseTools: pool.baseTools,
    modeTools: pool.modeTools,
    deferredToolPool: pool.deferredToolPool,
    getToolDefinition: (name: string) =>
      pool.dynamicDefs[name] ?? registry.get(name),
    projectRules,
    toolUseContext,
    subagentNames: getSubagentNames(registry),
    concurrencyPolicy: buildConcurrencyPolicy(registry),
    permissionMode: session.permissionMode.mode,
    mainThreadProfile: pool.mainThreadProfile,
    denyGlobs: pool.denyGlobs,
    planFilePath,
    modeChanged: slash.modeChanged,
    toolContext,
  }
}
