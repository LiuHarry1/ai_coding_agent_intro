import * as fs from 'node:fs'
import * as path from 'node:path'
import { getProjectAppDir, getUserAppDir } from '../../utils/app-dir.js'
import { isPathInWorkspace } from '../../core/workspace.js'

export type AgentMemoryScope = 'user' | 'project' | 'local'

const MAX_ENTRYPOINT_BYTES = 20 * 1024

function safeAgentDirName(agentType: string): string {
  return (
    agentType
      .normalize('NFC')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '') || 'agent'
  )
}

export function getAgentMemoryDir(
  agentType: string,
  scope: AgentMemoryScope,
  cwd: string,
): string {
  const dirName = safeAgentDirName(agentType)
  switch (scope) {
    case 'user':
      return path.join(getUserAppDir(), 'agent-memory', dirName)
    case 'project':
      return path.join(getProjectAppDir(cwd), 'agent-memory', dirName)
    case 'local':
      return path.join(getProjectAppDir(cwd), 'agent-memory-local', dirName)
  }
}

function resolveThroughExistingAncestor(input: string): string {
  let current = path.resolve(input)
  const missing: string[] = []
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) break
    missing.unshift(path.basename(current))
    current = parent
  }
  return path.resolve(fs.realpathSync(current), ...missing)
}

export function loadAgentMemoryPrompt(
  agentType: string,
  scope: AgentMemoryScope,
  cwd: string,
): { memoryDir: string; prompt: string } {
  const memoryDir = getAgentMemoryDir(agentType, scope, cwd)
  const boundary = scope === 'user' ? getUserAppDir() : path.resolve(cwd)
  const realBoundary = resolveThroughExistingAncestor(boundary)
  const realMemoryDir = resolveThroughExistingAncestor(memoryDir)
  if (!isPathInWorkspace(realMemoryDir, realBoundary)) {
    throw new Error(
      `Agent memory path escapes its ${scope} scope: ${memoryDir}`,
    )
  }
  fs.mkdirSync(memoryDir, { recursive: true, mode: 0o700 })
  const entrypoint = path.join(memoryDir, 'MEMORY.md')
  let existing = ''
  try {
    existing = fs.readFileSync(entrypoint, 'utf-8')
  } catch {
    // The agent may create MEMORY.md on its first durable learning.
  }
  if (Buffer.byteLength(existing, 'utf-8') > MAX_ENTRYPOINT_BYTES) {
    existing =
      existing.slice(0, MAX_ENTRYPOINT_BYTES) +
      '\n\n[...truncated persistent agent memory]'
  }

  const scopeGuidance =
    scope === 'user'
      ? 'Keep entries general because this memory follows this agent across projects.'
      : scope === 'project'
        ? 'Keep entries specific to this project; this directory may be version controlled and shared.'
        : 'Keep entries specific to this project and machine; this directory is local-only.'

  const content = existing.trim()
    ? `\n\nCurrent MEMORY.md:\n\n${existing.trim()}`
    : ''
  return {
    memoryDir,
    prompt: `# Persistent Agent Memory

You have an independent persistent memory directory at \`${memoryDir}\`.
Use Read to recall it and Write/Edit to maintain \`MEMORY.md\` when you learn something durable for future invocations of this same agent.
Do not copy transient task progress, the parent conversation, or the main agent's Auto Memory into it.
${scopeGuidance}${content}`,
  }
}
