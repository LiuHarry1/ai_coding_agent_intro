/**
 * Auto-memory path resolution helpers.
 */
import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { getAgentHome } from '../../utils/request-scope.js'
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
  if (p === '~') return getAgentHome()
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(getAgentHome(), p.slice(2))
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
 * Order: settings `autoMemory.directory` / `autoMemoryDirectory`
 * (via trustedDirectory) → default under ~/.ai-agent/projects/
 */
export function getAutoMemPath(opts: AutoMemPathOptions): string {
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

/** Memory dirs are group-readable (755) so Glob/rg and multi-process deploys can traverse them. */
const AUTO_MEM_DIR_MODE = 0o755
const AUTO_MEM_FILE_MODE = 0o644

function chmodDirBestEffort(dir: string): void {
  try {
    fs.chmodSync(dir, AUTO_MEM_DIR_MODE)
  } catch {
    // Best-effort: repair legacy 0700 dirs on next session inject.
  }
}

/** Repair traverse perms on memory dir and its .ai-agent/projects/* ancestors. */
function repairMemoryDirTreePermissions(memPath: string): void {
  let dir = path.resolve(memPath)
  for (let i = 0; i < 4 && dir; i++) {
    chmodDirBestEffort(dir)
    const base = path.basename(dir)
    if (base === getAppDirName() || base === 'projects') {
      break
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
}

export function ensureAutoMemDir(memPath: string): void {
  fs.mkdirSync(memPath, { recursive: true, mode: AUTO_MEM_DIR_MODE })
  repairMemoryDirTreePermissions(memPath)
  const entry = getAutoMemEntrypoint(memPath)
  if (!fs.existsSync(entry)) {
    fs.writeFileSync(entry, '', {
      encoding: 'utf-8',
      mode: AUTO_MEM_FILE_MODE,
    })
  }
}

/** App dir basename for logging (e.g. .ai-agent). */
export function autoMemAppDirLabel(): string {
  return getAppDirName()
}
