/**
 * Auto-memory system append. Prefetch mode injects guidance only; legacy
 * index mode injects the bounded MEMORY.md entrypoint as its recall fallback.
 */
import type { AutoMemoryConfig } from '../../core/types.js'
import { loadAutoMemoryPrompt } from './prompts.js'
import {
  ensureAutoMemDir,
  getAutoMemPath,
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
  /** Trusted directory from user/local settings only. */
  trustedDirectory?: string
}

/**
 * Behavioral guide for system prompt (AGENTS already applied).
 * With prefetch disabled, include the bounded MEMORY.md index so disabling
 * the selector does not disable recall entirely.
 */
export function buildAutoMemorySystemAppend(
  opts: BuildAutoMemoryAppendOpts,
): string {
  const { cwd, config } = opts
  if (!config.enabled) return ''

  const pathOpts: AutoMemPathOptions = {
    cwd,
    trustedDirectory: opts.trustedDirectory ?? config.directory,
  }
  const memPath = getAutoMemPath(pathOpts)
  ensureAutoMemDir(memPath)

  const skipIndex = config.prefetchEnabled !== false
  const guide = loadAutoMemoryPrompt(memPath, skipIndex)
  if (skipIndex) return guide

  const { content } = truncateEntrypointContent(readEntrypointRaw(memPath))
  if (!content.trim()) return guide
  return `${guide}\n\n## Auto memory index\n\n${content}`
}

/** Pre-inject manifest string for extract forks. */
export function buildExistingMemoriesManifest(memPath: string): string {
  return formatMemoryManifest(scanMemoryFiles(memPath))
}
