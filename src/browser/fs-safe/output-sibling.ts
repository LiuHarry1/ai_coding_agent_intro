/**
 * Write beside the target as a `.part` file, pin with O_NOFOLLOW, then rename.
 */
import { randomUUID } from 'node:crypto'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { FsSafeError } from './errors.js'
import { sameFileIdentity } from './file-identity.js'
import { sanitizeUntrustedFileName } from './filename.js'

const OPEN_READ_WRITE_NOFOLLOW =
  fsSync.constants.O_RDWR |
  (process.platform !== 'win32' &&
  typeof fsSync.constants.O_NOFOLLOW === 'number'
    ? fsSync.constants.O_NOFOLLOW
    : 0)

function safeFallbackFileName(fallbackFileName?: string): string {
  return sanitizeUntrustedFileName(fallbackFileName ?? 'output.bin', 'output.bin')
}

function buildSiblingTempPath(
  targetPath: string,
  fallbackFileName?: string,
): string {
  const safeTail = sanitizeUntrustedFileName(
    path.basename(targetPath),
    safeFallbackFileName(fallbackFileName),
  )
  return path.join(
    path.dirname(targetPath),
    `.fs-safe-output-${process.pid}-${randomUUID()}-${safeTail}.part`,
  )
}

function assertStagedFile(
  pathname: fsSync.Stats,
  opened: fsSync.Stats,
  maxBytes?: number,
): void {
  if (pathname.isSymbolicLink() || !pathname.isFile() || !opened.isFile()) {
    throw new FsSafeError(
      'not-file',
      'sibling-staged output must be a regular file',
    )
  }
  if (!sameFileIdentity(pathname, opened)) {
    throw new FsSafeError(
      'path-mismatch',
      'sibling-staged output changed while opening',
    )
  }
  if (opened.nlink > 1) {
    throw new FsSafeError(
      'hardlink',
      'hardlinked sibling-staged output not allowed',
    )
  }
  if (maxBytes !== undefined && opened.size > maxBytes) {
    throw new FsSafeError(
      'too-large',
      `sibling-staged output exceeds maxBytes (${maxBytes})`,
    )
  }
}

async function openPinnedStagedFile(tempPath: string, maxBytes?: number) {
  const preview = await fs.lstat(tempPath)
  if (preview.isSymbolicLink()) {
    throw new FsSafeError('symlink', 'symlink sibling-staged output not allowed')
  }
  const handle = await fs.open(tempPath, OPEN_READ_WRITE_NOFOLLOW)
  try {
    const identity = await handle.stat()
    assertStagedFile(await fs.lstat(tempPath), identity, maxBytes)
    return { handle, identity }
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

async function syncFile(handle: fs.FileHandle): Promise<void> {
  try {
    await handle.sync()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
  }
}

async function cleanupTempPath(
  tempPath: string,
  identity?: fsSync.Stats,
): Promise<boolean> {
  try {
    const current = await fs.lstat(tempPath)
    if (
      !identity ||
      (!current.isSymbolicLink() && sameFileIdentity(current, identity))
    ) {
      await fs.rm(tempPath, { force: true })
    }
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

export async function writeExternalFileViaSibling(params: {
  finalPath: string
  write: (tempPath: string) => Promise<void>
  fallbackFileName?: string
  maxBytes?: number
  mode?: number
}): Promise<void> {
  const finalPath = path.resolve(params.finalPath)
  const tempPath = buildSiblingTempPath(finalPath, params.fallbackFileName)
  let stagedIdentity: fsSync.Stats | undefined
  let renamed = false
  try {
    await params.write(tempPath)
    const pinned = await openPinnedStagedFile(tempPath, params.maxBytes)
    stagedIdentity = pinned.identity
    try {
      if (params.mode !== undefined) {
        await pinned.handle.chmod(params.mode)
      }
      await syncFile(pinned.handle)
      const currentIdentity = await pinned.handle.stat()
      assertStagedFile(await fs.lstat(tempPath), currentIdentity, params.maxBytes)
      if (!sameFileIdentity(currentIdentity, stagedIdentity)) {
        throw new FsSafeError(
          'path-mismatch',
          'sibling-staged output changed before rename',
        )
      }
      await fs.rename(tempPath, finalPath)
      renamed = true
      const published = await fs.lstat(finalPath)
      if (
        published.isSymbolicLink() ||
        !sameFileIdentity(published, currentIdentity)
      ) {
        throw new FsSafeError(
          'path-mismatch',
          'sibling-staged output changed during rename',
        )
      }
    } finally {
      await pinned.handle.close().catch(() => undefined)
    }
  } finally {
    if (!renamed) {
      await cleanupTempPath(tempPath, stagedIdentity)
    }
  }
}
