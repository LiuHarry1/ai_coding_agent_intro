import * as path from 'path'

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

/**
 * Resolve a workspace-relative path.
 *
 * When `cwd` is a remote Linux path (`/home/...`) but the Control Plane runs on
 * Windows, Node's `path.resolve` would incorrectly produce `C:\home\...`.
 * Detect that case and use `path.posix` instead.
 */
export function resolvePath(
  cwd: string,
  filePath: string,
): { abs: string; error?: undefined } | { abs?: undefined; error: string } {
  if (isPosixAbsolute(cwd) || isPosixAbsolute(filePath)) {
    const base = cwd.replace(/\\/g, '/')
    const rel = filePath.replace(/\\/g, '/')
    const abs = path.posix.isAbsolute(rel)
      ? path.posix.normalize(rel)
      : path.posix.normalize(path.posix.join(base, rel))
    return { abs }
  }

  const abs = path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(cwd, filePath)
  return { abs }
}
