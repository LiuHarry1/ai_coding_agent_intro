import {
  cleanURL,
  decodeHtml,
  fetchWithTimeout,
  stripHtml,
} from '../http-utils.js'

interface SearXNGResult {
  title?: string
  url?: string
  content?: string
  engine?: string
  engines?: string[]
  score?: number
  publishedDate?: string
}

interface SearXNGResponse {
  query?: string
  number_of_results?: number
  results?: SearXNGResult[]
  answers?: string[]
  suggestions?: string[]
}

const DEFAULT_BASE_URL = 'http://localhost:8888'
const DEFAULT_TIMEOUT_MS = 10000

export interface WebSearchArgs {
  query: string
  max_results?: number
  language?: string
  categories?: string
  time_range?: 'day' | 'week' | 'month' | 'year'
}

export interface WebSearchHit {
  rank: number
  title: string
  url: string
  snippet: string
  engines?: string[]
  score?: number
  publishedDate?: string
}

export interface WebSearchPayload {
  query: string
  provider: 'searxng' | 'exa'
  source: string
  format: string
  totalResults?: number
  answers?: string[]
  suggestions?: string[]
  note?: string
  results: WebSearchHit[]
  content?: string
}

function parseHtmlResults(html: string, maxResults: number): WebSearchHit[] {
  const articles = html.match(/<article\b[\s\S]*?<\/article>/gi) || []

  return articles
    .slice(0, maxResults)
    .map((article, index) => {
      const titleMatch = article.match(
        /<h3[^>]*>\s*<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>\s*<\/h3>/i,
      )
      const contentMatch = article.match(
        /<p[^>]+class=["'][^"']*content[^"']*["'][^>]*>([\s\S]*?)<\/p>/i,
      )
      const enginesMatch = article.match(
        /<div[^>]+class=["'][^"']*engines[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
      )
      const engineSpans =
        enginesMatch?.[1].match(/<span[^>]*>([\s\S]*?)<\/span>/gi) || []

      return {
        rank: index + 1,
        title: titleMatch ? stripHtml(titleMatch[2]) : '',
        url: titleMatch ? decodeHtml(titleMatch[1]) : '',
        snippet: contentMatch ? stripHtml(contentMatch[1]) : '',
        engines: engineSpans.map(span => stripHtml(span)).filter(Boolean),
      }
    })
    .filter(item => item.title || item.url || item.snippet)
}

function buildSearchURL(
  baseURL: string,
  args: WebSearchArgs,
  format?: 'json',
): URL {
  const url = new URL('/search', baseURL)
  url.searchParams.set('q', args.query)
  url.searchParams.set('safesearch', '1')
  if (format) url.searchParams.set('format', format)
  if (args.language) url.searchParams.set('language', args.language)
  if (args.categories) url.searchParams.set('categories', args.categories)
  if (args.time_range) url.searchParams.set('time_range', args.time_range)
  return url
}

export async function searchWithSearXNG(
  args: WebSearchArgs,
  maxResults: number,
): Promise<WebSearchPayload | string> {
  const baseURL = cleanURL(
    process.env.SEARXNG_URL || process.env.SEARCH_API_URL || DEFAULT_BASE_URL,
  )

  try {
    const jsonUrl = buildSearchURL(baseURL, args, 'json')
    const jsonRes = await fetchWithTimeout({
      url: jsonUrl,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      headers: { Accept: 'application/json' },
    })

    if (jsonRes.ok) {
      const data = JSON.parse(jsonRes.text) as SearXNGResponse
      const results = (data.results || [])
        .filter(item => item.title || item.url || item.content)
        .slice(0, maxResults)
        .map((item, index) => ({
          rank: index + 1,
          title: item.title || '',
          url: item.url || '',
          snippet: item.content || '',
          engines: item.engines || (item.engine ? [item.engine] : undefined),
          score: item.score,
          publishedDate: item.publishedDate,
        }))

      return {
        query: args.query,
        provider: 'searxng',
        source: baseURL,
        format: 'json',
        totalResults: data.number_of_results,
        answers: data.answers?.slice(0, 3),
        suggestions: data.suggestions?.slice(0, 5),
        results,
      }
    }

    const htmlUrl = buildSearchURL(baseURL, args)
    const htmlRes = await fetchWithTimeout({
      url: htmlUrl,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      headers: { Accept: 'text/html,application/xhtml+xml' },
    })

    if (!htmlRes.ok) {
      return `Error: SearXNG search failed: JSON HTTP ${jsonRes.status}; HTML HTTP ${htmlRes.status}. URL: ${baseURL}`
    }

    return {
      query: args.query,
      provider: 'searxng',
      source: baseURL,
      format: 'html-fallback',
      note: `SearXNG JSON returned HTTP ${jsonRes.status}; parsed HTML results instead. To enable JSON, add json to search.formats in SearXNG settings.yml.`,
      results: parseHtmlResults(htmlRes.text, maxResults),
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return `Error: SearXNG search timed out after ${DEFAULT_TIMEOUT_MS}ms. URL: ${baseURL}`
    }
    const message = err instanceof Error ? err.message : String(err)
    return `Error: SearXNG search failed: ${message}. URL: ${baseURL}`
  }
}
