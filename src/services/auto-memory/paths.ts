/**
 * Auto-memory path resolution helpers.
 */
import { execSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { getAppDirName, getUserAppDir } from '../../utils/app-dir.js'
import { normalizeGitPath } from '../../core/platform.js'
import { isPathInWorkspace } from '../../core/workspace.js'

export const AUTO_MEM_ENTRYPOINT = 'MEMORY.md'
export const AUTO_MEM_DIRNAME = 'memory'

const MAX_SANITIZED_LENGTH = 200

/** Make an absolute path safe as a single directory name. */
export function sanitizePath(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= MAX_SANITIZED_LENGTH) return sanitized
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0
  }
  const h = Math.abs(hash).toString(36)
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${h}`
}

/**
 * Main-repo working tree root (worktrees share the main repo identity).
 * Falls back to null when not a git checkout.
 */
export function findCanonicalGitRoot(cwd: string): string | null {
  try {
    const gitRoot = normalizeGitPath(
      execSync('git rev-parse --show-toplevel', {
        cwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim(),
    )
    const commonRaw = execSync('git rev-parse --git-common-dir', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    const commonAbs = path.resolve(cwd, commonRaw)
    if (path.basename(commonAbs) === '.git') {
      return path.dirname(commonAbs)
    }
    return gitRoot
  } catch {
    return null
  }
}

function expandTilde(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2))
  }
  return p
}

export type AutoMemPathOptions = {
  cwd: string
  /**
   * Trusted directory override (env or user/local settings only).
   * Project settings must never supply this.
   */
  trustedDirectory?: string
}

/**
 * Resolve auto-memory directory.
 * Order: AI_AGENT_MEMORY_PATH → trustedDirectory → default under ~/.ai-agent/projects/
 */
export function getAutoMemPath(opts: AutoMemPathOptions): string {
  const envOverride = process.env.AI_AGENT_MEMORY_PATH?.trim()
  if (envOverride) {
    return path.resolve(expandTilde(envOverride))
  }
  if (opts.trustedDirectory?.trim()) {
    return path.resolve(expandTilde(opts.trustedDirectory.trim()))
  }
  const base =
    findCanonicalGitRoot(opts.cwd) ?? path.resolve(opts.cwd)
  return path.join(
    getUserAppDir(),
    'projects',
    sanitizePath(base),
    AUTO_MEM_DIRNAME,
  )
}

export function getAutoMemEntrypoint(memPath: string): string {
  return path.join(memPath, AUTO_MEM_ENTRYPOINT)
}

/** True when absPath is under the auto-memory directory (or is that dir). */
export function isAutoMemPath(absPath: string, memPath: string): boolean {
  return isPathInWorkspace(path.resolve(absPath), path.resolve(memPath))
}

export function ensureAutoMemDir(memPath: string): void {
  fs.mkdirSync(memPath, { recursive: true, mode: 0o700 })
  const entry = getAutoMemEntrypoint(memPath)
  if (!fs.existsSync(entry)) {
    fs.writeFileSync(entry, '', { encoding: 'utf-8', mode: 0o600 })
  }
}

export function isAutoMemoryDisabledByEnv(): boolean {
  const v = String(process.env.AI_AGENT_DISABLE_AUTO_MEMORY ?? '')
    .trim()
    .toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

/** App dir basename for logging (e.g. .ai-agent). */
export function autoMemAppDirLabel(): string {
  return getAppDirName()
}
