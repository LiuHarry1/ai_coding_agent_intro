import type {
  MarketplaceCapability,
  MarketplaceProviderConfig,
} from '../../core/types.js'

export type MarketplaceKind = 'skill' | 'agent' | 'bundle'
export type InstallState =
  'available' | 'installed' | 'updateAvailable' | 'conflict'

export interface MarketplaceItem {
  providerId: string
  externalId: string
  kind: MarketplaceKind
  name: string
  description?: string
  author?: string
  category?: string
  version?: string
  hash?: string
  downloads?: number
  updatedAt?: string
  installState?: InstallState
  localVersion?: string
  platformType?: string
  fileTree?: unknown
  anchorHits?: Array<{ platform: string; anchor: string; path: string }>
  warnings?: string[]
}

export interface MarketplacePage {
  items: MarketplaceItem[]
  page: number
  perPage: number
  total?: number
}

export interface MarketplaceQuery {
  kind: MarketplaceKind
  q?: string
  page: number
  perPage: number
}

export type MarketplaceArtifact =
  | {
      kind: 'skill'
      format: 'zip'
      bytes: Buffer
      item: MarketplaceItem
    }
  | {
      kind: 'skill'
      format: 'files'
      files: Array<{ path: string; contents: string }>
      item: MarketplaceItem
    }
  | {
      kind: 'agent'
      format: 'markdown'
      contents: string
      item: MarketplaceItem
    }
  | {
      kind: 'bundle'
      format: 'zip'
      bytes: Buffer
      item: MarketplaceItem
    }

export interface MarketplaceBundlePreview {
  name: string
  platformType?: string
  files: Array<{
    sourcePath: string
    targetPath?: string
    size: number
    state: 'ready' | 'owned' | 'conflict' | 'modified' | 'archiveOnly'
  }>
  warnings: string[]
  canInstall: boolean
  requiresConfirmation: boolean
}

export interface MarketplaceRequestContext {
  identityKey: string
}

export interface MarketplaceProvider {
  readonly config: MarketplaceProviderConfig
  readonly capabilities: readonly MarketplaceCapability[]
  authStatus(
    ctx: MarketplaceRequestContext,
  ): Promise<{ authenticated: boolean }>
  login?(
    ctx: MarketplaceRequestContext,
    credentials: { username: string; password: string },
  ): Promise<void>
  logout?(ctx: MarketplaceRequestContext): Promise<void>
  list(
    ctx: MarketplaceRequestContext,
    query: MarketplaceQuery,
  ): Promise<MarketplacePage>
  detail(
    ctx: MarketplaceRequestContext,
    kind: MarketplaceKind,
    id: string,
  ): Promise<MarketplaceItem>
  versions?(
    ctx: MarketplaceRequestContext,
    kind: MarketplaceKind,
    id: string,
  ): Promise<unknown[]>
  envSchema?(
    ctx: MarketplaceRequestContext,
    kind: MarketplaceKind,
    id: string,
  ): Promise<unknown[]>
  artifact(
    ctx: MarketplaceRequestContext,
    kind: MarketplaceKind,
    id: string,
    version?: string,
  ): Promise<MarketplaceArtifact>
}
