/**
 * Inject truncated MEMORY.md into system context (after AGENTS.md).
 */
import type { AutoMemoryConfig } from '../../core/types.js'
import { loadAutoMemoryPrompt } from './prompts.js'
import {
  ensureAutoMemDir,
  getAutoMemPath,
  isAutoMemoryDisabledByEnv,
  type AutoMemPathOptions,
} from './paths.js'
import {
  formatMemoryManifest,
  readEntrypointRaw,
  scanMemoryFiles,
  truncateEntrypointContent,
} from './scan.js'

export type BuildAutoMemoryAppendOpts = {
  cwd: string
  config: AutoMemoryConfig
  /** Trusted directory from user/local/env only. */
  trustedDirectory?: string
}

/**
 * Guide + optional index section for system prompt (AGENTS already applied).
 * Empty / whitespace-only MEMORY.md → guide only (or '' if disabled).
 */
export function buildAutoMemorySystemAppend(
  opts: BuildAutoMemoryAppendOpts,
): string {
  const { cwd, config } = opts
  if (!config.enabled || isAutoMemoryDisabledByEnv()) return ''

  const pathOpts: AutoMemPathOptions = {
    cwd,
    trustedDirectory: opts.trustedDirectory ?? config.directory,
  }
  const memPath = getAutoMemPath(pathOpts)
  ensureAutoMemDir(memPath)

  const parts: string[] = [loadAutoMemoryPrompt(memPath)]

  if (config.injectIndex !== false) {
    const raw = readEntrypointRaw(memPath)
    if (raw.trim()) {
      let { content } = truncateEntrypointContent(raw)
      const maxLines = config.injectMaxIndexLines ?? 50
      if (maxLines > 0) {
        const lines = content.split('\n')
        if (lines.length > maxLines) {
          content =
            lines.slice(0, maxLines).join('\n') +
            '\n\n[... truncated — older index lines omitted]'
        }
      }
      parts.push(
        [
          '## Auto memory index',
          '',
          `Contents of \`${memPath}/MEMORY.md\` (topic details: Read files under that directory):`,
          '',
          content.trimEnd(),
        ].join('\n'),
      )
    }
  }

  return parts.join('\n\n')
}

/** Pre-inject manifest string for extract forks. */
export function buildExistingMemoriesManifest(memPath: string): string {
  return formatMemoryManifest(scanMemoryFiles(memPath))
}
