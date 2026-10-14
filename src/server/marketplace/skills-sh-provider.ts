import type { MarketplaceProviderConfig } from '../../core/types.js'
import {
  endpoint,
  fetchWithLimits,
  MarketplaceError,
  readJSON,
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

function mapItem(providerId: string, value: unknown): MarketplaceItem {
  const row = asRecord(value)
  const id = String(row.id ?? row.skillId ?? row.slug ?? '')
  const source = typeof row.source === 'string' ? row.source : undefined
  const slug =
    typeof row.slug === 'string'
      ? row.slug
      : typeof row.skillId === 'string'
        ? row.skillId
        : (id.split('/').at(-1) ?? id)
  return {
    providerId,
    externalId: id,
    kind: 'skill',
    // Use the portable skill slug as the install identity. Registry display
    // names are not guaranteed to satisfy the Agent Skills name grammar.
    name: slug,
    description:
      typeof row.description === 'string' ? row.description : undefined,
    author: source?.split('/')[0],
    version: typeof row.version === 'string' ? row.version : undefined,
    hash: typeof row.hash === 'string' ? row.hash : undefined,
    downloads: typeof row.installs === 'number' ? row.installs : undefined,
  }
}

function encodePathId(id: string): string {
  return id.split('/').map(encodeURIComponent).join('/')
}

export class SkillsShProvider implements MarketplaceProvider {
  readonly capabilities = ['skills'] as const

  constructor(readonly config: MarketplaceProviderConfig) {}

  async authStatus(): Promise<{ authenticated: boolean }> {
    return { authenticated: true }
  }

  async list(
    _ctx: MarketplaceRequestContext,
    query: MarketplaceQuery,
  ): Promise<MarketplacePage> {
    if (query.kind !== 'skill') {
      throw new MarketplaceError('skills.sh supports skills only', 400)
    }
    const url = endpoint(this.config, '/search')
    const q = query.q?.trim()
    // skills.sh currently requires a query of at least two characters.
    url.searchParams.set('q', q && q.length >= 2 ? q : 'agent')
    url.searchParams.set('limit', String(query.perPage))
    const data = asRecord(
      unwrapData(await readJSON(await fetchWithLimits(url, {}, this.config))),
    )
    const rows = Array.isArray(data.skills)
      ? data.skills
      : Array.isArray(data.items)
        ? data.items
        : []
    return {
      items: rows.map(row => mapItem(this.config.id, row)),
      page: query.page,
      perPage: query.perPage,
      total: typeof data.count === 'number' ? data.count : rows.length,
    }
  }

  async detail(
    _ctx: MarketplaceRequestContext,
    kind: MarketplaceKind,
    id: string,
  ): Promise<MarketplaceItem> {
    if (kind !== 'skill') {
      throw new MarketplaceError('skills.sh supports skills only', 400)
    }
    const data = asRecord(unwrapData(await this.fetchDetail(id)))
    return mapItem(this.config.id, {
      ...data,
      id,
      slug: id.split('/').at(-1),
    })
  }

  async artifact(
    _ctx: MarketplaceRequestContext,
    kind: MarketplaceKind,
    id: string,
  ): Promise<MarketplaceArtifact> {
    if (kind !== 'skill') {
      throw new MarketplaceError('skills.sh supports skills only', 400)
    }
    const data = asRecord(unwrapData(await this.fetchDetail(id)))
    const rawFiles = Array.isArray(data.files) ? data.files : []
    const files = rawFiles
      .map(value => asRecord(value))
      .filter(
        value =>
          typeof value.path === 'string' && typeof value.contents === 'string',
      )
      .map(value => ({
        path: value.path as string,
        contents: value.contents as string,
      }))
    if (files.length === 0) {
      throw new MarketplaceError('skills.sh returned no skill files', 502)
    }
    return {
      kind: 'skill',
      format: 'files',
      files,
      item: mapItem(this.config.id, {
        ...data,
        id,
        slug: id.split('/').at(-1),
      }),
    }
  }

  private async fetchDetail(id: string): Promise<unknown> {
    const url = endpoint(this.config, `/download/${encodePathId(id)}`)
    return readJSON(await fetchWithLimits(url, {}, this.config))
  }
}
