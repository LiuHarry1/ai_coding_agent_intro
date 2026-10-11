import * as fs from 'node:fs'
import * as path from 'node:path'

export const BUNDLED_RG_PATH_ENV = 'BUNDLED_RG_PATH'

/**
 * Resolve the trusted ripgrep path injected by the packaged Electron parent.
 * Development, CLI, and remote workers fall back to the bare command name so
 * the OS can resolve a system installation without consulting the workspace.
 */
export function resolveRgCommand(env: NodeJS.ProcessEnv = process.env): string {
  const bundled = env[BUNDLED_RG_PATH_ENV]?.trim()
  if (!bundled || !path.isAbsolute(bundled)) return 'rg'

  try {
    return fs.statSync(bundled).isFile() ? bundled : 'rg'
  } catch {
    return 'rg'
  }
}
