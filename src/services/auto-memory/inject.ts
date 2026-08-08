/**
 * Auto-memory system append (guide only — MEMORY.md index is not injected).
 * Relevant topic files are surfaced via prefetch attachments.
 */
import type { AutoMemoryConfig } from '../../core/types.js'
import { loadAutoMemoryPrompt } from './prompts.js'
import {
  ensureAutoMemDir,
  getAutoMemPath,
  type AutoMemPathOptions,
} from './paths.js'
import { formatMemoryManifest, scanMemoryFiles } from './scan.js'

export type BuildAutoMemoryAppendOpts = {
  cwd: string
  config: AutoMemoryConfig
  /** Trusted directory from user/local settings only. */
  trustedDirectory?: string
}

/**
 * Behavioral guide for system prompt (AGENTS already applied).
 * Never injects MEMORY.md body — prefetch handles recall.
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
  return loadAutoMemoryPrompt(memPath, skipIndex)
}

/** Pre-inject manifest string for extract forks. */
export function buildExistingMemoriesManifest(memPath: string): string {
  return formatMemoryManifest(scanMemoryFiles(memPath))
}
