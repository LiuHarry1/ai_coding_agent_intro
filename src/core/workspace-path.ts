/**
 * Workspace path normalization that is safe on a Windows Control Plane
 * talking to a remote POSIX environment (SSH Worker).
 *
 * Kept in its own module to avoid circular imports with request-scope /
 * workspace.ts (those import each other via getAgentHome / expandTilde).
 */
import * as path from 'path'

/**
 * Normalize a workspace cwd without Win32-resolving remote POSIX paths.
 *
 * On Windows, `path.resolve('/home/...')` becomes `C:\home\...` (current-drive
 * root), which Git Bash then reports as `/c/home/...` — breaking SSH remotes.
 * Absolute POSIX paths and `~/…` are left as posix-normalized strings.
 *
 * Also recovers already-corrupted forms (`C:\home\…`, `/c/home/…`) back to
 * `/home/…` so existing sessions keep working after the fix.
 */
export function normalizeWorkspacePath(cwd: string): string {
  const trimmed = (cwd || '').trim()
  if (!trimmed) return trimmed

  const slash = trimmed.replace(/\\/g, '/')

  // Heal Win32 / Git-Bash mangling of absolute POSIX paths
  const driveHome = slash.match(
    /^[A-Za-z]:\/((?:home|Users|tmp|var|opt|usr|etc)\/.*)$/,
  )
  if (driveHome) return path.posix.normalize('/' + driveHome[1])
  const msysHome = slash.match(
    /^\/[A-Za-z]\/((?:home|Users|tmp|var|opt|usr|etc)\/.*)$/,
  )
  if (msysHome) return path.posix.normalize('/' + msysHome[1])

  if (
    slash === '~' ||
    slash.startsWith('~/') ||
    (slash.startsWith('/') && !/^[a-zA-Z]:/.test(trimmed))
  ) {
    return path.posix.normalize(slash)
  }
  return path.resolve(trimmed)
}

/** True when `cwd` looks like a remote/POSIX absolute path (not a Win32 drive). */
export function isPosixAbsolutePath(cwd: string): boolean {
  const n = (cwd || '').replace(/\\/g, '/')
  return (
    n === '~' ||
    n.startsWith('~/') ||
    (n.startsWith('/') && !/^[a-zA-Z]:/.test(cwd || ''))
  )
}
