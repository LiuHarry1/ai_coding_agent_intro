/**
 * Format task output for the model — Claude Code `outputFormatting.ts`.
 */
import { getTaskOutputPath } from './diskOutput.js'

export const TASK_MAX_OUTPUT_UPPER_LIMIT = 160_000
export const TASK_MAX_OUTPUT_DEFAULT = 32_000

export function getMaxTaskOutputLength(): number {
  const raw = process.env.TASK_MAX_OUTPUT_LENGTH
  if (!raw) return TASK_MAX_OUTPUT_DEFAULT
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 1) return TASK_MAX_OUTPUT_DEFAULT
  return Math.min(n, TASK_MAX_OUTPUT_UPPER_LIMIT)
}

export function formatTaskOutput(
  output: string,
  taskId: string,
): { content: string; wasTruncated: boolean } {
  const maxLen = getMaxTaskOutputLength()

  if (output.length <= maxLen) {
    return { content: output, wasTruncated: false }
  }

  const filePath = getTaskOutputPath(taskId)
  const header = `[Truncated. Full output: ${filePath}]\n\n`
  const availableSpace = maxLen - header.length
  const truncated = output.slice(-Math.max(0, availableSpace))

  return { content: header + truncated, wasTruncated: true }
}
