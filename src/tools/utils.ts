import * as path from 'path'
import * as os from 'os'

const MAX_OUTPUT = 30000

export function truncate(text: string, max: number = MAX_OUTPUT): string {
  if (text.length <= max) return text
  const half = Math.floor(max / 2)
  return (
    text.slice(0, half) +
    `\n\n... [${text.length - max} chars truncated] ...\n\n` +
    text.slice(-half)
  )
}

/** True for POSIX absolute paths like `/home/u/proj` (including when Control Plane is Windows). */
function isPosixAbsolute(p: string): boolean {
  const n = p.replace(/\\/g, '/')
  return n.startsWith('/') && !/^[a-zA-Z]:/.test(p)
}

/** Windows drive-absolute (`C:\…` / `C:/…`) or UNC (`\\server\share`). */
export function isWindowsAbsolute(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\[^\\/]+[\\/]/.test(p)
}

/**
 * Node win32 `path.join(cwd, abs)` can produce `C:\ws\C:\Users\…`.
 * Recover the trailing absolute segment when that antipattern appears.
 */
export function unwrapJoinedWindowsAbsolute(
  _cwd: string,
  filePath: string,
): string | null {
  // Second drive-absolute segment: …\C:\rest or …/C:/rest
  const m = filePath.match(/[\\/]([a-zA-Z]:[\\/][\s\S]+)$/)
  if (!m?.[1] || !isWindowsAbsolute(m[1])) return null
  const prefix = filePath.slice(0, m.index)
  // Require a drive-absolute (or UNC) prefix so we don't rewrite odd relative names.
  if (!isWindowsAbsolute(prefix) && !/^\\\\/.test(prefix)) return null
  return path.normalize(m[1])
}

/**
 * Resolve a tool file path (Claude Code `expandPath` semantics).
 *
 * - Absolute paths are normalized as-is (never joined onto cwd).
 * - Relative paths resolve against cwd.
 * - Supports `~` / `~/…`.
 * - When cwd is a remote Linux path but Control Plane is Windows, use posix.
 * - Repairs Node win32 `path.join(cwd, abs)` double-absolute antipattern.
 */
export function resolvePath(
  cwd: string,
  filePath: string,
): { abs: string; error?: undefined } | { abs?: undefined; error: string } {
  if (typeof filePath !== 'string') {
    return { error: 'Path must be a string' }
  }
  if (filePath.includes('\0') || cwd.includes('\0')) {
    return { error: 'Path contains null bytes' }
  }

  const trimmed = filePath.trim()
  if (!trimmed) {
    return { abs: path.resolve(cwd) }
  }

  if (trimmed === '~') {
    return { abs: os.homedir() }
  }
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return { abs: path.resolve(os.homedir(), trimmed.slice(2)) }
  }

  // Repair cwd\C:\… before other resolution.
  const unwrapped = unwrapJoinedWindowsAbsolute(cwd, trimmed)
  if (unwrapped) {
    return { abs: unwrapped }
  }

  // Git-bash style `/c/Users/...` on a Windows control plane.
  let processed = trimmed
  if (process.platform === 'win32' && /^\/[a-zA-Z]\//.test(trimmed)) {
    processed = `${trimmed[1]}:${trimmed.slice(2).replace(/\//g, '\\')}`
  }

  if (isPosixAbsolute(cwd) || isPosixAbsolute(processed)) {
    // Windows abs must not go through posix.join (treats `C:\…` as relative).
    if (isWindowsAbsolute(processed)) {
      return { abs: path.normalize(processed) }
    }
    const base = cwd.replace(/\\/g, '/')
    const rel = processed.replace(/\\/g, '/')
    const abs = path.posix.isAbsolute(rel)
      ? path.posix.normalize(rel)
      : path.posix.normalize(path.posix.join(base, rel))
    return { abs }
  }

  if (isWindowsAbsolute(processed) || path.isAbsolute(processed)) {
    return { abs: path.normalize(processed) }
  }

  // Always resolve — never path.join (win32 join(cwd, abs) concatenates).
  return { abs: path.resolve(cwd, processed) }
}
