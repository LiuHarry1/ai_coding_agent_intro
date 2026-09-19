/**
 * MemoryBinding — the single place that answers "which memory directory".
 *
 * Resolved once per turn, then handed to every consumer (system prompt,
 * filesystem roots, prefetch, turn-end extract) so those four can never drift
 * apart. Read set and write target are separate fields: today every policy
 * points them at the same directory, but a read-shared/write-private layering
 * becomes a config change rather than a refactor.
 */
import type {
  AgentDefinition,
  AgentMemoryScope,
  AutoMemoryConfig,
  MemoryPolicy,
  MemoryVocabulary,
} from '../../core/types.js'
import { getAgentMemoryDir } from '../../tools/AgentTool/agentMemory.js'
import { extractAgentMentions } from '../../utils/attachments/extract-mentions.js'
import { getAutoMemPath } from './paths.js'

export type MemoryPromptKind = 'none' | 'auto' | 'agent'
export type MemoryPromptPlacement = 'project-rules' | 'standalone'

export type MemoryBinding = {
  /** Recall search directories, in priority order. */
  readDirs: string[]
  /** Sole write target: extract output + write root. undefined = read-only. */
  writeDir: string | undefined
  prompt: {
    /** `auto` = loadAutoMemoryPrompt, `agent` = buildMemoryPrompt. */
    kind: MemoryPromptKind
    vocabulary: MemoryVocabulary
    /** Shared memory rides along with project rules; private is standalone. */
    placement: MemoryPromptPlacement
    /** Directory the prompt describes — always the write target. */
    dir: string | undefined
    /** Prefetch mode owns recall, so MEMORY.md is not injected or maintained. */
    skipIndex: boolean
    /** Set for `agent` kind: the agent whose memdir this is. */
    agentType?: string
    /** Set for `agent` kind: drives the scope note in the prompt. */
    scope?: AgentMemoryScope
  }
  extract: { enabled: boolean }
  roots: { read: string[]; write: string[] }
  /** For logs only. */
  source: 'shared' | 'disabled' | `agent:${string}`
}

export type ResolveMemoryBindingOpts = {
  cwd: string
  config: AutoMemoryConfig
  /** Resolved primary profile for this turn, if any. */
  profile: AgentDefinition | null
  /** Active agents, for resolving @agent mentions. */
  agents?: readonly AgentDefinition[]
  /** Current user message, for resolving @agent mentions. */
  queryText?: string
  remote: boolean
}

const DISABLED_BINDING: MemoryBinding = {
  readDirs: [],
  writeDir: undefined,
  prompt: {
    kind: 'none',
    vocabulary: 'coding',
    placement: 'project-rules',
    dir: undefined,
    skipIndex: true,
  },
  extract: { enabled: false },
  roots: { read: [], write: [] },
  source: 'disabled',
}

/** Policy of a primary profile, or undefined when it uses shared memory. */
function privatePolicyOf(
  profile: AgentDefinition | null,
): MemoryPolicy | undefined {
  const policy = profile?.memoryPolicy
  if (!policy || policy.mode !== 'private') return undefined
  return policy
}

/**
 * CC: an @-mentioned agent with its own memdir narrows recall to that memdir.
 * Mentions never move the write target.
 */
function mentionedMemoryDirs(opts: ResolveMemoryBindingOpts): string[] {
  const { queryText, agents, cwd } = opts
  if (!queryText || !agents?.length) return []
  return extractAgentMentions(queryText).flatMap(agentType => {
    const def = agents.find(a => a.agentType === agentType)
    if (!def?.memory || def.mode === 'primary') return []
    return [getAgentMemoryDir(agentType, def.memory, cwd)]
  })
}

function uniq(dirs: ReadonlyArray<string | undefined>): string[] {
  return [...new Set(dirs.filter((d): d is string => !!d))]
}

/**
 * Resolve this turn's memory binding. The whole priority order lives here:
 *
 * 1. remote workspace or auto memory off → disabled
 * 2. primary profile with a private policy → its own memdir, standalone prompt
 * 3. otherwise → shared project auto memory
 *
 * On top of (2)/(3), an @agent mention narrows `readDirs` only.
 */
export function resolveMemoryBinding(
  opts: ResolveMemoryBindingOpts,
): MemoryBinding {
  const { cwd, config, profile, remote } = opts
  if (remote || !config.enabled) return DISABLED_BINDING

  const skipIndex = config.prefetchEnabled !== false
  const privatePolicy = privatePolicyOf(profile)

  const base: MemoryBinding = privatePolicy
    ? (() => {
        const agentType = profile!.agentType
        const dir = getAgentMemoryDir(agentType, privatePolicy.scope, cwd)
        return {
          readDirs: [dir],
          writeDir: dir,
          prompt: {
            kind: 'agent' as const,
            vocabulary: privatePolicy.vocabulary,
            placement: 'standalone' as const,
            dir,
            skipIndex,
            agentType,
            scope: privatePolicy.scope,
          },
          extract: { enabled: true },
          roots: { read: [dir], write: [dir] },
          source: `agent:${agentType}` as const,
        }
      })()
    : (() => {
        const dir = getAutoMemPath({ cwd, trustedDirectory: config.directory })
        return {
          readDirs: [dir],
          writeDir: dir,
          prompt: {
            kind: 'auto' as const,
            vocabulary: 'coding' as const,
            placement: 'project-rules' as const,
            dir,
            skipIndex,
          },
          extract: { enabled: true },
          roots: { read: [dir], write: [dir] },
          source: 'shared' as const,
        }
      })()

  const mentioned = mentionedMemoryDirs(opts)
  if (mentioned.length === 0) return base

  // Recall follows the mention; the prompt, write target, and extract do not.
  return {
    ...base,
    readDirs: mentioned,
    roots: {
      read: uniq([...mentioned, base.writeDir]),
      write: base.roots.write,
    },
  }
}

/** One-line binding summary for turn logs. */
export function describeMemoryBinding(binding: MemoryBinding): string {
  if (binding.prompt.kind === 'none') return 'memory=disabled'
  return (
    `memory=${binding.source} read=[${binding.readDirs.join(', ')}] ` +
    `write=${binding.writeDir ?? 'none'} ` +
    `prompt=${binding.prompt.kind}/${binding.prompt.vocabulary}/${binding.prompt.placement}`
  )
}
