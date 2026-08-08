/**
 * Memory freshness helpers (aligned with Claude Code memdir/memoryAge.ts).
 */

/** Floor days since mtime; future/clock-skew clamps to 0. */
export function memoryAgeDays(mtimeMs: number): number {
  return Math.max(0, Math.floor((Date.now() - mtimeMs) / 86_400_000))
}

/** Human-readable age — models reason better on "47 days ago" than ISO. */
export function memoryAge(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs)
  if (d === 0) return 'today'
  if (d === 1) return 'yesterday'
  return `${d} days ago`
}

/**
 * Staleness caveat for memories older than 1 day. Empty for today/yesterday.
 */
export function memoryFreshnessText(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs)
  if (d <= 1) return ''
  return (
    `This memory is ${d} days old. ` +
    `Memories are point-in-time observations, not live state — ` +
    `claims about code behavior or file:line citations may be outdated. ` +
    `Verify against current code before asserting as fact.`
  )
}

/** Header for a relevant-memory block (stored at attachment creation time). */
export function memoryHeader(filePath: string, mtimeMs: number): string {
  const staleness = memoryFreshnessText(mtimeMs)
  return staleness
    ? `${staleness}\n\nMemory: ${filePath}:`
    : `Memory (saved ${memoryAge(mtimeMs)}): ${filePath}:`
}
