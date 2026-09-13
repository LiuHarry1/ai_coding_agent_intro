/**
 * Re-inject recently-read file contents after compaction (SM + full paths).
 */
import * as fs from 'fs'
import * as path from 'path'
import type { Message } from '../../core/types.js'
import { isRoleMessage } from '../../core/types.js'
import { FILE_READ_TOOL_NAME } from '../../constants/tool_names.js'

export type FileRestoreBudget = {
  maxFiles: number
  maxTokensPerFile: number
  totalBudget: number
}

export function extractRecentlyReadFiles(
  messages: Message[],
  maxFiles = 8,
): string[] {
  const files: string[] = []
  for (let i = messages.length - 1; i >= 0 && files.length < maxFiles; i--) {
    const m = messages[i]
    if (!isRoleMessage(m) || m.role !== 'assistant') continue
    for (const part of m.content) {
      if (part.type !== 'tool-call' || part.toolName !== FILE_READ_TOOL_NAME)
        continue
      const filePath =
        ((part.input as Record<string, unknown>)?.file_path as
          | string
          | undefined) ??
        ((part.input as Record<string, unknown>)?.path as string | undefined)
      if (filePath && !files.includes(filePath)) {
        files.push(filePath)
      }
    }
  }
  return files
}

/**
 * Re-inject file contents after compaction.
 *
 * Files the model can still see as Read results in `preservedMessages` are
 * skipped: the preserved tail already carries that content, so restoring it
 * again is pure duplication (CC applies the same diff in
 * `createPostCompactFileAttachments`).
 */
export function restoreRecentFiles(
  recentPaths: string[],
  cwd: string,
  config: FileRestoreBudget,
  preservedMessages: readonly Message[] = [],
): string {
  if (recentPaths.length === 0) return ''

  const resolve = (p: string) =>
    path.isAbsolute(p) ? p : path.resolve(cwd, p)
  const preserved = new Set(
    extractRecentlyReadFiles(
      preservedMessages as Message[],
      Number.POSITIVE_INFINITY,
    ).map(resolve),
  )

  const maxCharPerFile = config.maxTokensPerFile * 4
  const totalCharBudget = config.totalBudget * 4
  let usedChars = 0
  const sections: string[] = []

  for (const filePath of recentPaths.slice(0, config.maxFiles)) {
    const abs = resolve(filePath)
    if (preserved.has(abs)) continue
    try {
      if (!fs.existsSync(abs)) continue
      const stat = fs.statSync(abs)
      if (stat.isDirectory() || stat.size > 512 * 1024) continue

      let content = fs.readFileSync(abs, 'utf-8')
      if (content.length > maxCharPerFile) {
        content =
          content.slice(0, maxCharPerFile) + '\n[... truncated for compaction]'
      }

      if (usedChars + content.length > totalCharBudget) break
      usedChars += content.length

      sections.push(`### ${filePath}\n\`\`\`\n${content}\n\`\`\``)
    } catch {
      continue
    }
  }

  if (sections.length === 0) return ''
  return `## Restored File Contents\nThese files were recently accessed. Their current content is included so you can continue working immediately.\n\n${sections.join('\n\n')}`
}
