/**
 * Tool-name glob matching for agent `disallowedTools` / `tools` lists.
 * Supports exact names and a single trailing `*` (OpenCode-style `server_*`).
 */

export function matchToolGlob(name: string, pattern: string): boolean {
  if (!pattern) return false
  if (pattern === name) return true
  if (pattern.endsWith('*') && !pattern.slice(0, -1).includes('*')) {
    return name.startsWith(pattern.slice(0, -1))
  }
  return false
}

export function isToolNameDisallowed(
  name: string,
  patterns: readonly string[] | undefined,
): boolean {
  if (!patterns || patterns.length === 0) return false
  return patterns.some(p => matchToolGlob(name, p))
}

/** Delete keys from a tools record that match any deny glob. */
export function filterToolsRecordByDisallowedGlobs<T>(
  tools: Record<string, T>,
  patterns: readonly string[] | undefined,
): Record<string, T> {
  if (!patterns || patterns.length === 0) return tools
  const out: Record<string, T> = {}
  for (const [name, tool] of Object.entries(tools)) {
    if (!isToolNameDisallowed(name, patterns)) out[name] = tool
  }
  return out
}

/** Drop deferred defs whose names match deny globs. */
export function filterDeferredDefsByDisallowedGlobs<
  T extends { name: string },
>(defs: readonly T[], patterns: readonly string[] | undefined): T[] {
  if (!patterns || patterns.length === 0) return [...defs]
  return defs.filter(d => !isToolNameDisallowed(d.name, patterns))
}
