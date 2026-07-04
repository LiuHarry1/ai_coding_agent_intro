/**
 * Classify tool names for UI routing. MCP tools are merged as
 * `{mcpServerName}_{toolName}` (see examples/08-basic/core/mcp-manager.ts).
 */

/** Built-in `WebFetch` and MCP names like `mcp_server_fetch`. */
export function isFetchTool(name) {
  if (!name) return false
  if (name === 'WebFetch' || name === 'fetch') return true
  return name.endsWith('_fetch')
}

/** Built-in `WebSearch` and MCP search tools (`*_search`, `*_web_search`). */
export function isSearchTool(name) {
  if (!name) return false
  if (name === 'WebSearch' || name === 'search') return true
  return name.endsWith('_search') || name.endsWith('_web_search')
}

/**
 * Split a merged MCP tool name into server + tool.
 * `mcp_server_fetch` → { server: "mcp_server", tool: "fetch" }
 */
export function parseMcpToolName(name) {
  if (!name) return { server: null, tool: '' }
  const suffixes = ['WebSearch', 'WebFetch', 'fetch', 'search']
  for (const suffix of suffixes) {
    const marker = `_${suffix}`
    if (name.endsWith(marker)) {
      return { server: name.slice(0, -marker.length) || null, tool: suffix }
    }
  }
  return { server: null, tool: name }
}
