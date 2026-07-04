/**
 * Small parsing helpers for YAML frontmatter values.
 *
 * Keep this file dependency-free so every kind of markdown extension
 * (agents / skills / commands / output-styles / memory) can reuse the same
 * normalization rules without importing each other.
 */

/**
 * Parse a tool list that may be:
 *   - undefined  →  undefined  (caller decides default: "all" vs "none")
 *   - null / ""  →  []         (explicitly empty)
 *   - "a, b, c"  →  ["a", "b", "c"]
 *   - ["a", "b"] →  ["a", "b"]
 *   - "*"        →  undefined  (= all)
 */
export function parseToolList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return []

  let arr: string[]
  if (typeof value === 'string') {
    arr = value
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  } else if (Array.isArray(value)) {
    arr = value.filter(
      (v): v is string => typeof v === 'string' && v.trim() !== '',
    )
  } else {
    return []
  }

  if (arr.includes('*')) return undefined // wildcard ⇒ all tools
  return arr
}

/**
 * Parse `paths:` frontmatter — glob patterns this extension applies to.
 * Accepts comma-separated string or YAML list. Does NOT brace-expand here
 * (matching against picomatch/minimatch handles braces natively).
 */
export function parseGlobList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') {
    const list = value
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
    return list.length ? list : undefined
  }
  if (Array.isArray(value)) {
    const list = value.filter(
      (v): v is string => typeof v === 'string' && v.trim() !== '',
    )
    return list.length ? list : undefined
  }
  return undefined
}

export function parseBool(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === 'true') return true
    if (v === 'false') return false
  }
  return undefined
}

export function parsePositiveInt(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  const n = typeof value === 'number' ? value : parseInt(String(value), 10)
  if (Number.isInteger(n) && n > 0) return n
  return undefined
}

export function parseString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Parse a "name" key from frontmatter as a stable identifier.
 * Used for agent/skill validation: must be a non-empty string. Returns null on miss
 * so callers can silently skip non-extension markdown files in the dir.
 */
export function parseIdentifier(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Parse "arguments:" frontmatter for slash commands. Accepts space-separated
 * string or array. Numeric-only names are dropped (conflict with `$0`/`$1`).
 */
export function parseArgumentNames(value: unknown): string[] {
  if (value === undefined || value === null) return []
  const isValid = (s: string) => s.trim() !== '' && !/^\d+$/.test(s)
  if (Array.isArray(value)) {
    return value
      .filter((v): v is string => typeof v === 'string')
      .filter(isValid)
  }
  if (typeof value === 'string') {
    return value.split(/\s+/).filter(isValid)
  }
  return []
}
