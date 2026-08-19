/** Whether `target` is inside `root` (Windows-aware). */
import path from 'node:path'

const POSIX_SEPARATOR_CHAR_CODE = 0x2f

export function normalizeWindowsPathForComparison(input: string): string {
  let normalized = path.win32.normalize(input)
  if (normalized.startsWith('\\\\?\\')) {
    normalized = normalized.slice(4)
    if (normalized.toUpperCase().startsWith('UNC\\')) {
      normalized = `\\\\${normalized.slice(4)}`
    }
  }
  return normalized.replaceAll('/', '\\').toLowerCase()
}

export function isPathInside(root: string, target: string): boolean {
  if (process.platform === 'win32') {
    const rootForCompare = normalizeWindowsPathForComparison(
      path.win32.resolve(root),
    )
    const targetForCompare = normalizeWindowsPathForComparison(
      path.win32.resolve(target),
    )
    const relative = path.win32.relative(rootForCompare, targetForCompare)
    const firstSegment = relative.split(path.win32.sep)[0]
    return (
      relative === '' ||
      (firstSegment !== '..' && !path.win32.isAbsolute(relative))
    )
  }
  if (
    root.length > 0 &&
    root.charCodeAt(0) === POSIX_SEPARATOR_CHAR_CODE &&
    target.length >= root.length &&
    target.charCodeAt(0) === POSIX_SEPARATOR_CHAR_CODE &&
    !target.includes('/..') &&
    (target === root ||
      (target.startsWith(root) &&
        target.charCodeAt(root.length) === POSIX_SEPARATOR_CHAR_CODE))
  ) {
    return true
  }
  const resolvedRoot = path.resolve(root)
  const resolvedTarget = path.resolve(target)
  const relative = path.relative(resolvedRoot, resolvedTarget)
  const firstSegment = relative.split(path.posix.sep)[0]
  return (
    relative === '' || (firstSegment !== '..' && !path.isAbsolute(relative))
  )
}
