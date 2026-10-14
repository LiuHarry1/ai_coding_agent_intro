import type { MarketplaceProviderConfig } from '../../core/types.js'
import {
  endpoint,
  fetchWithLimits,
  MarketplaceError,
  readJSON,
  readLimitedBuffer,
  unwrapData,
} from './http.js'
import type {
  MarketplaceArtifact,
  MarketplaceItem,
  MarketplaceKind,
  MarketplacePage,
  MarketplaceProvider,
  MarketplaceQuery,
  MarketplaceRequestContext,
} from './types.js'

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {}
}

function firstString(...values: unknown[]): string | undefined {
  return values.find(v => typeof v === 'string' && v.length > 0) as
    string | undefined
}

function resourceFor(kind: MarketplaceKind): string {
  if (kind === 'skill') return 'agent-skills'
  if (kind === 'agent') return 'agents'
  return 'ai-contexts'
}

function mapItem(
  providerId: string,
  kind: MarketplaceKind,
  value: unknown,
): MarketplaceItem {
  const row = asRecord(value)
  const name =
    firstString(row.name, row.title, row.slug) ?? String(row.id ?? 'unknown')
  const anchorHits = Array.isArray(row.anchorHits)
    ? row.anchorHits.flatMap(value => {
        const hit = asRecord(value)
        const platform = firstString(hit.platform)
        const anchor = firstString(hit.anchor)
        const path = firstString(hit.path)
        return platform && anchor && path ? [{ platform, anchor, path }] : []
      })
    : undefined
  return {
    providerId,
    externalId: String(row.id ?? name),
    kind,
    name,
    description: firstString(row.description, row.content),
    author: firstString(row.authorName, row.author),
    category: firstString(row.categoryName),
    version: firstString(row.version, row.draftVersion),
    hash: firstString(row.hash, row.checksum),
    downloads:
      typeof row.downloadCount === 'number' ? row.downloadCount : undefined,
    updatedAt: firstString(row.updateDateTime, row.publishedAt),
    platformType: firstString(row.platformType),
    fileTree: row.fileTree,
    anchorHits,
    warnings: Array.isArray(row.warnings)
      ? row.warnings.filter(
          (warning): warning is string => typeof warning === 'string',
        )
      : undefined,
  }
}

function cookiePairs(headers: Headers): string[] {
  const h = headers as Headers & { getSetCookie?: () => string[] }
  const values = h.getSetCookie?.() ?? []
  if (values.length === 0) {
    const single = headers.get('set-cookie')
    if (single) values.push(single)
  }
  return values
    .map(value => value.split(';', 1)[0]?.trim())
    .filter((value): value is string => Boolean(value))
}

function mergeCookies(current: string | undefined, next: string[]): string {
  const pairs = new Map<string, string>()
  for (const raw of [...(current?.split('; ') ?? []), ...next]) {
    const eq = raw.indexOf('=')
    if (eq > 0) pairs.set(raw.slice(0, eq), raw)
  }
  return [...pairs.values()].join('; ')
}

/**
 * Cookie sessions live at module scope, keyed by registry URL, so they survive
 * provider re-creation (settings edits, cache churn, another workspace using
 * the same registry). They are intentionally memory-only: a process restart
 * requires a fresh login rather than persisting auth cookies to disk.
 */
const sessionStores = new Map<string, Map<string, string>>()

function sessionStoreFor(
  config: MarketplaceProviderConfig,
): Map<string, string> {
  const key = config.baseURL.replace(/\/+$/, '').toLowerCase()
  let store = sessionStores.get(key)
  if (!store) {
    store = new Map()
    sessionStores.set(key, store)
  }
  return store
}

export class DemeterProvider implements MarketplaceProvider {
  readonly capabilities
  private readonly sessions: Map<string, string>

  constructor(readonly config: MarketplaceProviderConfig) {
    this.capabilities = config.capabilities ?? ['skills', 'agents', 'bundles']
    this.sessions = sessionStoreFor(config)
  }

  async authStatus(
    ctx: MarketplaceRequestContext,
  ): Promise<{ authenticated: boolean }> {
    if (!this.sessions.has(ctx.identityKey)) return { authenticated: false }
    const response = await this.request(ctx, '/auth/session', {}, false)
    if (response.status === 401) {
      this.sessions.delete(ctx.identityKey)
      return { authenticated: false }
    }
    return { authenticated: response.ok }
  }

  async login(
    ctx: MarketplaceRequestContext,
    credentials: { username: string; password: string },
  ): Promise<void> {
    const response = await fetchWithLimits(
      endpoint(this.config, '/auth/login'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(credentials),
      },
      this.config,
    )
    await readJSON(response.clone())
    const cookies = cookiePairs(response.headers)
    if (cookies.length === 0) {
      throw new MarketplaceError(
        'Marketplace login did not return an authentication session',
        502,
      )
    }
    this.sessions.set(ctx.identityKey, mergeCookies(undefined, cookies))
  }

  async logout(ctx: MarketplaceRequestContext): Promise<void> {
    if (this.sessions.has(ctx.identityKey)) {
      await this.request(ctx, '/auth/logout', { method: 'POST' }).catch(
        () => {},
      )
    }
    this.sessions.delete(ctx.identityKey)
  }

  async list(
    ctx: MarketplaceRequestContext,
    query: MarketplaceQuery,
  ): Promise<MarketplacePage> {
    this.assertKind(query.kind)
    const resource = resourceFor(query.kind)
    const path = query.q
      ? `/marketplace/${resource}/search`
      : `/marketplace/${resource}`
    const url = endpoint(this.config, path)
    if (query.q) url.searchParams.set('q', query.q)
    if (!(query.kind === 'bundle' && query.q)) {
      url.searchParams.set('page', String(query.page))
    }
    url.searchParams.set('perPage', String(query.perPage))
    if (!query.q) url.searchParams.set('isPublished', 'true')
    const payload = unwrapData(await readJSON(await this.requestURL(ctx, url)))
    const root = asRecord(payload)
    const rows = Array.isArray(payload)
      ? payload
      : Array.isArray(root.items)
        ? root.items
        : Array.isArray(root.data)
          ? root.data
          : Array.isArray(root.results)
            ? root.results
            : []
    const meta = asRecord(root.meta)
    const totalRaw = root.total ?? meta.total ?? meta.totalItems
    return {
      items: rows.map(row => mapItem(this.config.id, query.kind, row)),
      page: query.page,
      perPage: query.perPage,
      total: typeof totalRaw === 'number' ? totalRaw : undefined,
    }
  }

  async detail(
    ctx: MarketplaceRequestContext,
    kind: MarketplaceKind,
    id: string,
  ): Promise<MarketplaceItem> {
    this.assertKind(kind)
    const resource = resourceFor(kind)
    const data = unwrapData(
      await readJSON(
        await this.request(
          ctx,
          `/marketplace/${resource}/${encodeURIComponent(id)}`,
        ),
      ),
    )
    return mapItem(this.config.id, kind, data)
  }

  async versions(
    ctx: MarketplaceRequestContext,
    kind: MarketplaceKind,
    id: string,
  ): Promise<unknown[]> {
    this.assertKind(kind)
    const resource = resourceFor(kind)
    const data = unwrapData(
      await readJSON(
        await this.request(
          ctx,
          `/marketplace/${resource}/${encodeURIComponent(id)}/versions`,
        ),
      ),
    )
    if (Array.isArray(data)) return data
    const root = asRecord(data)
    return Array.isArray(root.items)
      ? root.items
      : Array.isArray(root.data)
        ? root.data
        : []
  }

  async envSchema(
    ctx: MarketplaceRequestContext,
    kind: MarketplaceKind,
    id: string,
  ): Promise<unknown[]> {
    if (kind !== 'skill') return []
    const data = unwrapData(
      await readJSON(
        await this.request(
          ctx,
          `/marketplace/agent-skills/${encodeURIComponent(id)}/env-schema`,
        ),
      ),
    )
    return Array.isArray(data) ? data : []
  }

  async artifact(
    ctx: MarketplaceRequestContext,
    kind: MarketplaceKind,
    id: string,
    version?: string,
  ): Promise<MarketplaceArtifact> {
    this.assertKind(kind)
    const item = await this.detail(ctx, kind, id)
    const resource = resourceFor(kind)
    const historicalVersion =
      version && /^\d+$/.test(version) ? version : undefined
    const suffix = historicalVersion
      ? `/${encodeURIComponent(id)}/versions/${historicalVersion}/download`
      : `/${encodeURIComponent(id)}/download`
    const response = await this.request(
      ctx,
      `/marketplace/${resource}${suffix}`,
    )
    const bytes = await readLimitedBuffer(
      response,
      this.config.maxDownloadBytes ?? 10 * 1024 * 1024,
    )
    if (kind === 'skill' || kind === 'bundle') {
      return { kind, format: 'zip', bytes, item }
    }
    return {
      kind,
      format: 'markdown',
      contents: bytes.toString('utf8'),
      item,
    }
  }

  private assertKind(kind: MarketplaceKind): void {
    const capability =
      kind === 'skill' ? 'skills' : kind === 'agent' ? 'agents' : 'bundles'
    if (!this.capabilities.includes(capability)) {
      throw new MarketplaceError(
        `Marketplace '${this.config.id}' does not support ${capability}`,
        400,
      )
    }
  }

  private request(
    ctx: MarketplaceRequestContext,
    path: string,
    init: RequestInit = {},
    retry = true,
  ): Promise<Response> {
    return this.requestURL(ctx, endpoint(this.config, path), init, retry)
  }

  private async requestURL(
    ctx: MarketplaceRequestContext,
    url: URL,
    init: RequestInit = {},
    retry = true,
  ): Promise<Response> {
    const cookie = this.sessions.get(ctx.identityKey)
    if (!cookie) throw new MarketplaceError('Marketplace login required', 401)
    const response = await fetchWithLimits(
      url,
      {
        ...init,
        headers: { ...init.headers, Cookie: cookie },
      },
      this.config,
    )
    const next = cookiePairs(response.headers)
    if (next.length > 0) {
      this.sessions.set(ctx.identityKey, mergeCookies(cookie, next))
    }
    if (response.status !== 401 || !retry) return response
    const refreshed = await fetchWithLimits(
      endpoint(this.config, '/auth/refresh'),
      { method: 'POST', headers: { Cookie: cookie } },
      this.config,
    )
    if (!refreshed.ok) return response
    const refreshedCookies = mergeCookies(
      cookie,
      cookiePairs(refreshed.headers),
    )
    this.sessions.set(ctx.identityKey, refreshedCookies)
    return fetchWithLimits(
      url,
      {
        ...init,
        headers: { ...init.headers, Cookie: refreshedCookies },
      },
      this.config,
    )
  }
}
