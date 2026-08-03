/**
 * Path suggestions when Read misses a file (CC-style UX).
 */
import * as fs from 'fs'
import * as path from 'path'

/**
 * Same basename, different extension in the same directory.
 * e.g. auth.ts missing → suggest auth.js if present.
 */
export function findSimilarFile(filePath: string): string | undefined {
  try {
    const dir = path.dirname(filePath)
    const base = path.basename(filePath, path.extname(filePath))
    const entries = fs.readdirSync(dir)
    const match = entries.find(name => {
      const full = path.join(dir, name)
      return (
        path.basename(name, path.extname(name)) === base && full !== filePath
      )
    })
    return match
  } catch {
    return undefined
  }
}

/**
 * "Dropped repo folder" pattern: path is under cwd's parent but not under cwd.
 * If the same relative path under cwd exists, suggest that.
 *
 * Example (CC):
 *   cwd = /Users/zeeg/src/currentRepo
 *   requested = /Users/zeeg/src/foobar
 *   → /Users/zeeg/src/currentRepo/foobar (if it exists)
 */
export function suggestPathUnderCwd(
  cwd: string,
  requestedPath: string,
): string | undefined {
  const absRequested = path.isAbsolute(requestedPath)
    ? path.normalize(requestedPath)
    : path.resolve(cwd, requestedPath)
  const absCwd = path.resolve(cwd)
  const cwdParent = path.dirname(absCwd)
  const sep = path.sep
  const parentPrefix = cwdParent.endsWith(sep) ? cwdParent : cwdParent + sep

  if (
    !absRequested.startsWith(parentPrefix) ||
    absRequested === absCwd ||
    absRequested.startsWith(absCwd + sep)
  ) {
    return undefined
  }

  const relFromParent = path.relative(cwdParent, absRequested)
  const corrected = path.join(absCwd, relFromParent)
  return fs.existsSync(corrected) ? corrected : undefined
}

/** Build a friendly not-found message with optional Did you mean… */
export function formatFileNotFoundMessage(
  cwd: string,
  absPath: string,
  displayPath: string,
): string {
  let message = `File does not exist: ${displayPath}. Note: your current working directory is ${cwd}.`
  const cwdSuggestion = suggestPathUnderCwd(cwd, absPath)
  if (cwdSuggestion) {
    const rel = path.relative(cwd, cwdSuggestion)
    message += ` Did you mean ${rel || cwdSuggestion}?`
    return message
  }
  const similar = findSimilarFile(absPath)
  if (similar) {
    message += ` Did you mean ${similar}?`
  }
  return message
}
