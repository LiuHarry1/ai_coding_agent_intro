/** Walk up until an existing path, or null at the filesystem root. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { FsSafeError } from './errors.js'

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return Boolean(value && typeof value === 'object' && 'code' in value)
}

export function assertAbsolutePathInput(filePath: string): string {
  if (!path.isAbsolute(filePath)) {
    throw new FsSafeError('invalid-path', 'path must be absolute')
  }
  return path.normalize(filePath)
}

export async function findExistingAncestor(
  filePath: string,
): Promise<string | null> {
  let current = path.resolve(filePath)
  while (true) {
    try {
      await fs.lstat(current)
      return current
    } catch (err) {
      if (!isNodeError(err) || err.code !== 'ENOENT') {
        throw err
      }
    }
    const parent = path.dirname(current)
    if (parent === current) {
      return null
    }
    current = parent
  }
}
