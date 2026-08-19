/** Create output directories, canonicalizing macOS /tmp and /var aliases. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { ensureAbsoluteDirectory } from './fs-safe/ensure-absolute-directory.js'

async function resolveSystemDirectoryAlias(dirPath: string): Promise<string> {
  for (const aliasRoot of ['/tmp', '/var']) {
    if (dirPath !== aliasRoot && !dirPath.startsWith(`${aliasRoot}${path.sep}`)) {
      continue
    }
    try {
      const stat = await fs.lstat(aliasRoot)
      if (!stat.isSymbolicLink()) {
        return dirPath
      }
      return path.join(
        await fs.realpath(aliasRoot),
        path.relative(aliasRoot, dirPath),
      )
    } catch {
      return dirPath
    }
  }
  return dirPath
}

export async function ensureOutputDirectory(dirPath: string): Promise<void> {
  const result = await ensureAbsoluteDirectory(
    await resolveSystemDirectoryAlias(path.resolve(dirPath)),
    {
      scopeLabel: 'output directory',
    },
  )
  if (!result.ok) {
    throw result.error
  }
}
