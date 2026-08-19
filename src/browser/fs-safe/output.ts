/** Write a file under a root, using sibling-temp then rename. */
import path from 'node:path'
import { FsSafeError } from './errors.js'
import { sanitizeUntrustedFileName } from './filename.js'
import { isPathInside } from './path-inside.js'
import { ensureAbsoluteDirectory } from './ensure-absolute-directory.js'
import { writeExternalFileViaSibling } from './output-sibling.js'

const NON_PORTABLE_FILE_NAME_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f<>:"/\\|?*]/u

function tempFileNameForTarget(
  targetPath: string,
  fallbackFileName?: string,
): string {
  const fallback = sanitizeUntrustedFileName(
    fallbackFileName ?? 'output.bin',
    'output.bin',
  )
  return sanitizeUntrustedFileName(path.basename(targetPath), fallback)
}

function sanitizedTargetPath(
  targetPath: string,
  fallbackFileName?: string,
): string {
  const basename = path.basename(targetPath)
  if (!NON_PORTABLE_FILE_NAME_CHARACTERS.test(basename)) {
    return targetPath
  }
  const sanitized = tempFileNameForTarget(targetPath, fallbackFileName)
  return sanitized === basename
    ? targetPath
    : path.join(path.dirname(targetPath), sanitized)
}

function ensureTrailingSep(value: string): string {
  return value.endsWith(path.sep) ? value : `${value}${path.sep}`
}

function toRootPathInput(params: {
  rootDir: string
  targetPath: string
}): string {
  if (!path.isAbsolute(params.targetPath)) {
    return params.targetPath
  }
  const absoluteTarget = path.resolve(params.targetPath)
  const rootDir = path.resolve(params.rootDir)
  if (isPathInside(ensureTrailingSep(rootDir), absoluteTarget)) {
    return path.relative(rootDir, absoluteTarget)
  }
  return params.targetPath
}

function assertFileTargetPath(targetPath: string): void {
  const basename = path.basename(targetPath)
  if (
    !targetPath ||
    targetPath === '.' ||
    targetPath.endsWith('/') ||
    targetPath.endsWith('\\') ||
    !basename ||
    basename === '.' ||
    basename === '..'
  ) {
    throw new FsSafeError('invalid-path', 'target path must name a file')
  }
}

export type ExternalFileWriteOptions = {
  rootDir: string
  path: string
  write: (tempPath: string) => Promise<void>
  fallbackFileName?: string
  maxBytes?: number
  mode?: number
}

export async function writeExternalFileWithinRootBase(
  options: ExternalFileWriteOptions,
): Promise<{ path: string }> {
  const rootDir = path.resolve(options.rootDir)
  const requestedTargetPath = options.path
  if (requestedTargetPath.length === 0) {
    throw new FsSafeError('invalid-path', 'target path is required')
  }
  assertFileTargetPath(requestedTargetPath)
  const rawTargetPath = toRootPathInput({
    rootDir,
    targetPath: requestedTargetPath,
  })
  assertFileTargetPath(rawTargetPath)
  if (path.isAbsolute(rawTargetPath)) {
    throw new FsSafeError('invalid-path', 'target path escapes output root')
  }
  const targetPath = sanitizedTargetPath(
    rawTargetPath,
    options.fallbackFileName,
  )
  const finalPath = path.resolve(rootDir, targetPath)
  if (!isPathInside(ensureTrailingSep(rootDir), finalPath)) {
    throw new FsSafeError('invalid-path', 'target path escapes output root')
  }
  const parent = path.dirname(finalPath)
  const ensured = await ensureAbsoluteDirectory(parent, {
    scopeLabel: 'output directory',
  })
  if (!ensured.ok) {
    throw ensured.error
  }
  await writeExternalFileViaSibling({
    finalPath,
    write: options.write,
    fallbackFileName: options.fallbackFileName,
    maxBytes: options.maxBytes,
    mode: options.mode,
  })
  return { path: finalPath }
}

export async function writeExternalFileWithinRoot(
  options: ExternalFileWriteOptions,
): Promise<{ path: string }> {
  const requestedPath = path.resolve(options.rootDir, options.path)
  const result = await writeExternalFileWithinRootBase(options)
  return {
    path: path.join(path.dirname(requestedPath), path.basename(result.path)),
  }
}
