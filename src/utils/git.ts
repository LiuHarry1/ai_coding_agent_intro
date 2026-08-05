/**
 * Minimal git helpers — naming aligned with Claude Code `utils/git.ts`.
 */
import { spawnSync } from 'child_process'
import { getCwd } from './cwd.js'

/** Whether `getCwd()` is inside a git work tree. CC: `getIsGit`. */
export async function getIsGit(): Promise<boolean> {
  try {
    const r = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: getCwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 2000,
    })
    return r.status === 0 && String(r.stdout ?? '').trim() === 'true'
  } catch {
    return false
  }
}
