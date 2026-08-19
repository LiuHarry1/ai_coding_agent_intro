/** Write a browser output file only if it stays under the chosen root. */
import path from 'node:path'
import { writeExternalFileWithinRoot } from './fs-safe/output.js'
import { ensureOutputDirectory } from './output-directories.js'

export async function writeExternalFileWithinOutputRoot(params: {
  rootDir?: string
  path: string
  write: (filePath: string) => Promise<void>
}): Promise<string> {
  const outputPath = params.path.trim()
  if (!outputPath) {
    throw new Error('output path is required')
  }

  const rootDir = params.rootDir
    ? path.resolve(params.rootDir)
    : path.dirname(path.resolve(outputPath))
  await ensureOutputDirectory(rootDir)

  const result = await writeExternalFileWithinRoot({
    rootDir,
    path: outputPath,
    write: params.write,
  }).catch((err: unknown) => {
    if (
      err instanceof Error &&
      (err as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      throw new Error('output directory changed while writing file', {
        cause: err,
      })
    }
    throw err
  })
  return result.path
}
