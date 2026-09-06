/**
 * Main-repo working tree root (worktrees share the main repo identity).
 * Falls back to null when not a git checkout.
 */
import { execSync } from 'child_process'
import * as path from 'path'
import { normalizeGitPath } from '../core/platform.js'

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
