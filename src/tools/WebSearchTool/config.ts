export type WebSearchProvider = 'searxng' | 'exa'

/**
 * Switch web search backend:
 *   WEB_SEARCH_PROVIDER=exa       (default) — Exa MCP (optional EXA_API_KEY)
 *   WEB_SEARCH_PROVIDER=searxng   — self-hosted SearXNG
 */
export function getWebSearchProvider(): WebSearchProvider {
  const raw = (process.env.WEB_SEARCH_PROVIDER || 'exa').trim().toLowerCase()
  return raw === 'searxng' ? 'searxng' : 'exa'
}

export function webSearchProviderLabel(provider: WebSearchProvider): string {
  return provider === 'exa' ? 'Exa Web Search' : 'SearXNG Web Search'
}
