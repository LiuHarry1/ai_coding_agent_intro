/**
 * Persistent per-subagent memory (aligned with Claude Code agentMemory.ts).
 * Paths use `.ai-agent` instead of `.claude`; user scope under agent home.
 */
import * as fs from 'fs'
import { join, normalize, sep } from 'path'
import { getAgentHome } from '../../utils/request-scope.js'
import { getAppDirName } from '../../utils/app-dir.js'
import { getCwd } from '../../utils/cwd.js'
import { findCanonicalGitRoot } from '../../utils/git-root.js'
import { sanitizePath } from '../../utils/sanitize-path.js'
import { AUTO_MEM_ENTRYPOINT } from '../../services/auto-memory/paths.js'
import {
  truncateEntrypointContent,
} from '../../services/auto-memory/scan.js'
import {
  MEMORY_FRONTMATTER_EXAMPLE,
  TRUSTING_RECALL_SECTION,
  TYPES_SECTION_INDIVIDUAL,
  WHAT_NOT_TO_SAVE_SECTION,
  WHEN_TO_ACCESS_SECTION,
} from '../../services/auto-memory/types.js'

export type AgentMemoryScope = 'user' | 'project' | 'local'

const AGENT_MEMORY_DIRNAME = 'agent-memory'
const AGENT_MEMORY_LOCAL_DIRNAME = 'agent-memory-local'

const DIR_EXISTS_GUIDANCE =
  'This directory already exists — write to it directly with the Write tool (do not run mkdir or check for its existence).'

/** Replace colons (plugin-scoped types) for filesystem-safe directory names. */
export function sanitizeAgentTypeForPath(agentType: string): string {
  return agentType.replace(/:/g, '-')
}

function getMemoryBaseDir(): string {
  if (process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR) {
    return process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR
  }
  return join(getAgentHome(), getAppDirName())
}

function getLocalAgentMemoryDir(dirName: string, cwd?: string): string {
  const root = cwd ?? getCwd()
  if (process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR) {
    return (
      join(
        process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR,
        'projects',
        sanitizePath(findCanonicalGitRoot(root) ?? root),
        AGENT_MEMORY_LOCAL_DIRNAME,
        dirName,
      ) + sep
    )
  }
  return join(root, getAppDirName(), AGENT_MEMORY_LOCAL_DIRNAME, dirName) + sep
}

/**
 * Agent memory directory for a type + scope.
 * - user: `{agentHome}/.ai-agent/agent-memory/<type>/`
 * - project: `{cwd}/.ai-agent/agent-memory/<type>/`
 * - local: `{cwd}/.ai-agent/agent-memory-local/<type>/` (or remote mount)
 */
export function getAgentMemoryDir(
  agentType: string,
  scope: AgentMemoryScope,
  cwd?: string,
): string {
  const dirName = sanitizeAgentTypeForPath(agentType)
  const root = cwd ?? getCwd()
  switch (scope) {
    case 'project':
      return join(root, getAppDirName(), AGENT_MEMORY_DIRNAME, dirName) + sep
    case 'local':
      return getLocalAgentMemoryDir(dirName, root)
    case 'user':
      return join(getMemoryBaseDir(), AGENT_MEMORY_DIRNAME, dirName) + sep
  }
}

/** True if path is under any agent-memory scope directory. */
export function isAgentMemoryPath(absolutePath: string, cwd?: string): boolean {
  const normalizedPath = normalize(absolutePath)
  const memoryBase = getMemoryBaseDir()
  const root = cwd ?? getCwd()
  const app = getAppDirName()

  if (normalizedPath.startsWith(join(memoryBase, AGENT_MEMORY_DIRNAME) + sep)) {
    return true
  }

  if (
    normalizedPath.startsWith(
      join(root, app, AGENT_MEMORY_DIRNAME) + sep,
    )
  ) {
    return true
  }

  if (process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR) {
    if (
      normalizedPath.includes(sep + AGENT_MEMORY_LOCAL_DIRNAME + sep) &&
      normalizedPath.startsWith(
        join(process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR, 'projects') + sep,
      )
    ) {
      return true
    }
  } else if (
    normalizedPath.startsWith(
      join(root, app, AGENT_MEMORY_LOCAL_DIRNAME) + sep,
    )
  ) {
    return true
  }

  return false
}

export function getAgentMemoryEntrypoint(
  agentType: string,
  scope: AgentMemoryScope,
  cwd?: string,
): string {
  return join(getAgentMemoryDir(agentType, scope, cwd), AUTO_MEM_ENTRYPOINT)
}

export function getMemoryScopeDisplay(
  memory: AgentMemoryScope | undefined,
): string {
  switch (memory) {
    case 'user':
      return `User (${join(getMemoryBaseDir(), AGENT_MEMORY_DIRNAME)}/)`
    case 'project':
      return `Project (${getAppDirName()}/agent-memory/)`
    case 'local':
      return `Local (${getLocalAgentMemoryDir('...')})`
    default:
      return 'None'
  }
}

export function ensureAgentMemoryDirExists(memoryDir: string): void {
  try {
    fs.mkdirSync(memoryDir, { recursive: true })
  } catch {
    // Prompt building continues; Write tool mkdir parent on write.
  }
}

function buildAgentMemoryLines(
  displayName: string,
  memoryDir: string,
  extraGuidelines?: string[],
): string[] {
  const howToSave = [
    '## How to save memories',
    '',
    'Saving a memory is a two-step process:',
    '',
    '**Step 1** — write the memory to its own file (e.g., `user_role.md`, `feedback_testing.md`) using this frontmatter format:',
    '',
    ...MEMORY_FRONTMATTER_EXAMPLE,
    '',
    `**Step 2** — add a pointer to that file in \`${AUTO_MEM_ENTRYPOINT}\`. \`${AUTO_MEM_ENTRYPOINT}\` is an index, not a memory — each entry should be one line, under ~150 characters: \`- [Title](file.md) — one-line hook\`. It has no frontmatter. Never write memory content directly into \`${AUTO_MEM_ENTRYPOINT}\`.`,
    '',
    `- \`${AUTO_MEM_ENTRYPOINT}\` is always loaded into your conversation context — keep the index concise`,
    '- Keep the name, description, and type fields in memory files up-to-date with the content',
    '- Organize memory semantically by topic, not chronologically',
    '- Update or remove memories that turn out to be wrong or outdated',
    '- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.',
  ]

  return [
    `# ${displayName}`,
    '',
    `You have a persistent, file-based memory system at \`${memoryDir}\`. ${DIR_EXISTS_GUIDANCE}`,
    '',
    "You should build up this memory system over time so that future conversations can have a complete picture of who the user is, how they'd like to collaborate with you, what behaviors to avoid or repeat, and the context behind the work the user gives you.",
    '',
    'If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.',
    '',
    ...TYPES_SECTION_INDIVIDUAL,
    ...WHAT_NOT_TO_SAVE_SECTION,
    '',
    ...howToSave,
    '',
    ...WHEN_TO_ACCESS_SECTION,
    '',
    ...TRUSTING_RECALL_SECTION,
    '',
    '## Memory and other forms of persistence',
    'Memory is one of several persistence mechanisms available to you as you assist the user in a given conversation. The distinction is often that memory can be recalled in future conversations and should not be used for persisting information that is only useful within the scope of the current conversation.',
    '- When to use or update a plan instead of memory: If you are about to start a non-trivial implementation task and would like to reach alignment with the user on your approach you should use a Plan rather than saving this information to memory. Similarly, if you already have a plan within the conversation and you have changed your approach persist that change by updating the plan rather than saving a memory.',
    '- When to use or update tasks instead of memory: When you need to break your work in current conversation into discrete steps or keep track of your progress use tasks instead of saving to memory. Tasks are great for persisting information about the work that needs to be done in the current conversation, but memory should be reserved for information that will be useful in future conversations.',
    '',
    ...(extraGuidelines ?? []),
    '',
  ]
}

/** Build typed-memory prompt with MEMORY.md content (CC buildMemoryPrompt). */
export function buildAgentMemoryPrompt(params: {
  displayName: string
  memoryDir: string
  extraGuidelines?: string[]
}): string {
  const { displayName, memoryDir, extraGuidelines } = params
  const entrypoint = join(memoryDir, AUTO_MEM_ENTRYPOINT)

  let entrypointContent = ''
  try {
    entrypointContent = fs.readFileSync(entrypoint, { encoding: 'utf-8' })
  } catch {
    // No memory file yet
  }

  const lines = buildAgentMemoryLines(
    displayName,
    memoryDir,
    extraGuidelines,
  )

  if (entrypointContent.trim()) {
    const t = truncateEntrypointContent(entrypointContent)
    lines.push(`## ${AUTO_MEM_ENTRYPOINT}`, '', t.content)
  } else {
    lines.push(
      `## ${AUTO_MEM_ENTRYPOINT}`,
      '',
      `Your ${AUTO_MEM_ENTRYPOINT} is currently empty. When you save new memories, they will appear here.`,
    )
  }

  return lines.join('\n')
}

/**
 * Load persistent memory prompt for a subagent with memory enabled.
 * Creates the memory directory (sync) and returns prompt + MEMORY.md index.
 */
export function loadAgentMemoryPrompt(
  agentType: string,
  scope: AgentMemoryScope,
  cwd?: string,
): string {
  let scopeNote: string
  switch (scope) {
    case 'user':
      scopeNote =
        '- Since this memory is user-scope, keep learnings general since they apply across all projects'
      break
    case 'project':
      scopeNote =
        '- Since this memory is project-scope and shared with your team via version control, tailor your memories to this project'
      break
    case 'local':
      scopeNote =
        '- Since this memory is local-scope (not checked into version control), tailor your memories to this project and machine'
      break
  }

  const memoryDir = getAgentMemoryDir(agentType, scope, cwd)
  ensureAgentMemoryDirExists(memoryDir)

  const coworkExtraGuidelines =
    process.env.CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES
  return buildAgentMemoryPrompt({
    displayName: 'Persistent Agent Memory',
    memoryDir,
    extraGuidelines:
      coworkExtraGuidelines && coworkExtraGuidelines.trim().length > 0
        ? [scopeNote, coworkExtraGuidelines]
        : [scopeNote],
  })
}

export function parseAgentMemoryScope(
  raw: unknown,
): AgentMemoryScope | undefined {
  if (typeof raw !== 'string') return undefined
  const v = raw.trim().toLowerCase()
  if (v === 'user' || v === 'project' || v === 'local') return v
  return undefined
}
