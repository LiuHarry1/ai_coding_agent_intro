// Claude Code `src/utils/shell/outputLimits.ts`

export const BASH_MAX_OUTPUT_UPPER_LIMIT = 150_000
export const BASH_MAX_OUTPUT_DEFAULT = 30_000

export function getMaxOutputLength(): number {
  const raw = process.env.BASH_MAX_OUTPUT_LENGTH
  if (!raw) return BASH_MAX_OUTPUT_DEFAULT
  const parsed = parseInt(raw, 10)
  if (isNaN(parsed) || parsed <= 0) return BASH_MAX_OUTPUT_DEFAULT
  if (parsed > BASH_MAX_OUTPUT_UPPER_LIMIT) return BASH_MAX_OUTPUT_UPPER_LIMIT
  return parsed
}
