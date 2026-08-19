/**
 * Create an absolute directory one segment at a time. Rejects symlinks.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { findExistingAncestor } from './find-existing-ancestor.js'

export async function ensureAbsoluteDirectory(
  dirPath: string,
  options?: { scopeLabel?: string; mode?: number },
): Promise<{ ok: true; path: string } | { ok: false; error: Error }> {
  const absolutePath = path.resolve(dirPath)
  const scopeLabel = options?.scopeLabel ?? 'directory'
  const existingAncestor = await findExistingAncestor(absolutePath)
  if (!existingAncestor) {
    return {
      ok: false,
      error: new Error(`Invalid path: must stay within ${scopeLabel}`),
    }
  }
  if (existingAncestor === absolutePath) {
    try {
      const stat = await fs.lstat(absolutePath)
      if (!stat.isSymbolicLink() && stat.isDirectory()) {
        return { ok: true, path: absolutePath }
      }
    } catch {
      // Fall through to the uniform invalid-path result below.
    }
    return {
      ok: false,
      error: new Error(`Invalid path: must stay within ${scopeLabel}`),
    }
  }
  const relative = path.relative(existingAncestor, absolutePath)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    return {
      ok: false,
      error: new Error(`Invalid path: must stay within ${scopeLabel}`),
    }
  }
  let current = existingAncestor
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    try {
      const st = await fs.lstat(current)
      if (st.isSymbolicLink() || !st.isDirectory()) {
        return {
          ok: false,
          error: new Error(`Invalid path: must stay within ${scopeLabel}`),
        }
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EEXIST') {
        const st = await fs.lstat(current)
        if (st.isSymbolicLink() || !st.isDirectory()) {
          return {
            ok: false,
            error: new Error(`Invalid path: must stay within ${scopeLabel}`),
          }
        }
        continue
      }
      if (code !== 'ENOENT') {
        throw err
      }
      await fs.mkdir(current, { mode: options?.mode ?? 0o700 })
    }
  }
  return { ok: true, path: absolutePath }
}
