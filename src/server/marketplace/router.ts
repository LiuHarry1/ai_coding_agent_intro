import type { IncomingMessage, ServerResponse } from 'http'
import { loadWorkspaceContributions } from '../../core/workspace-load.js'
import { readBody, sendJSON } from '../http.js'
import { isAuthEnabled, type AuthedRequest } from '../auth/identity.js'
import { resolveRequestCwd } from '../request-cwd.js'
import {
  decorateInstallState,
  installMarketplaceArtifact,
  previewMarketplaceBundle,
  readMarketplaceLock,
  uninstallMarketplaceArtifact,
} from './installer.js'
import { MarketplaceError } from './http.js'
import {
  getMarketplaceProvider,
  getMarketplaceProviders,
  marketplaceProviderSummary,
} from './providers.js'
import type { MarketplaceKind, MarketplaceRequestContext } from './types.js'

function parseKind(value: unknown): MarketplaceKind {
  if (value === 'skill' || value === 'agent' || value === 'bundle') return value
  throw new MarketplaceError("kind must be 'skill', 'agent', or 'bundle'", 400)
}

/**
 * Marketplace sessions (e.g. Demeter cookies) are keyed by identity. In SSO
 * mode a request without a resolved user must never fall back to the shared
 * single-user key, otherwise tenants could reuse each other's sessions.
 */
function identityContext(req: IncomingMessage): MarketplaceRequestContext {
  const authed = req as AuthedRequest
  if (isAuthEnabled()) {
    const email = authed.user?.email?.trim()
    if (!email) throw new MarketplaceError('Authentication required', 401)
    return { identityKey: email.toLowerCase() }
  }
  return { identityKey: 'local-single-user' }
}

function positiveInt(
  value: string | null,
  fallback: number,
  max: number,
): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0
    ? Math.min(parsed, max)
    : fallback
}

async function localNames(cwd: string): Promise<{
  skills: Set<string>
  agents: Set<string>
}> {
  const contributions = await loadWorkspaceContributions(cwd)
  return {
    skills: new Set(contributions.skills.map(skill => skill.name)),
    agents: new Set(
      contributions.agents.allAgents.map(agent => agent.agentType),
    ),
  }
}

export function createMarketplaceRouter() {
  return async function marketplaceRouter(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://agent.local')
    if (!url.pathname.startsWith('/marketplaces')) return false
    const cwd = resolveRequestCwd(
      req,
      url.searchParams.get('workspace') ?? undefined,
    )

    try {
      const ctx = identityContext(req)
      if (req.method === 'GET' && url.pathname === '/marketplaces/providers') {
        const providers = getMarketplaceProviders(cwd)
        const summaries = await Promise.all(
          providers.map(async provider => ({
            ...marketplaceProviderSummary(provider),
            ...(await provider.authStatus(ctx)),
          })),
        )
        sendJSON(res, 200, { providers: summaries })
        return true
      }

      const match = url.pathname.match(
        /^\/marketplaces\/([^/]+)\/(auth\/session|auth\/login|auth\/logout|catalog|detail|versions|env-schema|preview|install|uninstall)$/,
      )
      if (!match) {
        sendJSON(res, 404, { error: 'Marketplace endpoint not found' })
        return true
      }
      const provider = getMarketplaceProvider(
        cwd,
        decodeURIComponent(match[1]!),
      )
      const action = match[2]!

      if (req.method === 'GET' && action === 'auth/session') {
        sendJSON(res, 200, await provider.authStatus(ctx))
        return true
      }
      if (req.method === 'POST' && action === 'auth/login') {
        if (!provider.login) {
          throw new MarketplaceError('Provider does not require login', 400)
        }
        const body = await readBody(req)
        if (
          typeof body.username !== 'string' ||
          typeof body.password !== 'string'
        ) {
          throw new MarketplaceError('username and password are required', 400)
        }
        await provider.login(ctx, {
          username: body.username,
          password: body.password,
        })
        sendJSON(res, 200, { authenticated: true })
        return true
      }
      if (req.method === 'POST' && action === 'auth/logout') {
        await provider.logout?.(ctx)
        sendJSON(res, 200, { authenticated: false })
        return true
      }

      if (req.method === 'GET' && action === 'catalog') {
        const kind = parseKind(url.searchParams.get('kind'))
        const page = positiveInt(url.searchParams.get('page'), 1, 10_000)
        const perPage = positiveInt(url.searchParams.get('perPage'), 20, 100)
        const result = await provider.list(ctx, {
          kind,
          q: url.searchParams.get('q')?.trim() || undefined,
          page,
          perPage,
        })
        const [lock, names] = await Promise.all([
          readMarketplaceLock(cwd),
          localNames(cwd),
        ])
        const enrichedItems = await Promise.all(
          result.items.map(async item => {
            const installed = lock.entries.some(
              entry =>
                entry.providerId === item.providerId &&
                entry.kind === item.kind &&
                entry.externalId === item.externalId,
            )
            if (!installed || item.hash || item.version) return item
            try {
              return await provider.detail(ctx, item.kind, item.externalId)
            } catch {
              return item
            }
          }),
        )
        sendJSON(res, 200, {
          ...result,
          items: enrichedItems.map(item =>
            decorateInstallState(item, lock, names),
          ),
        })
        return true
      }

      const kind = parseKind(url.searchParams.get('kind'))
      const id = url.searchParams.get('id')
      if (!id) throw new MarketplaceError('id is required', 400)

      if (req.method === 'GET' && action === 'detail') {
        const [item, lock, names] = await Promise.all([
          provider.detail(ctx, kind, id),
          readMarketplaceLock(cwd),
          localNames(cwd),
        ])
        sendJSON(res, 200, {
          item: decorateInstallState(item, lock, names),
        })
        return true
      }
      if (req.method === 'GET' && action === 'versions') {
        sendJSON(res, 200, {
          versions: provider.versions
            ? await provider.versions(ctx, kind, id)
            : [],
        })
        return true
      }
      if (req.method === 'GET' && action === 'env-schema') {
        sendJSON(res, 200, {
          variables: provider.envSchema
            ? await provider.envSchema(ctx, kind, id)
            : [],
        })
        return true
      }
      if (req.method === 'POST' && action === 'install') {
        const body = await readBody(req)
        const version =
          typeof body.version === 'string' ? body.version : undefined
        const artifact = await provider.artifact(ctx, kind, id, version)
        const installed = await installMarketplaceArtifact(
          cwd,
          provider.config,
          artifact,
          {
            confirmBundleConflicts:
              kind === 'bundle' && body.confirmConflicts === true,
          },
        )
        sendJSON(res, 200, { installed })
        return true
      }
      if (req.method === 'POST' && action === 'preview') {
        if (kind !== 'bundle') {
          throw new MarketplaceError(
            'Preview is currently available for AI Bundles',
            400,
          )
        }
        const body = await readBody(req)
        const version =
          typeof body.version === 'string' ? body.version : undefined
        const artifact = await provider.artifact(ctx, kind, id, version)
        if (artifact.kind !== 'bundle') {
          throw new MarketplaceError(
            'Provider returned an invalid AI Bundle artifact',
            502,
          )
        }
        sendJSON(res, 200, {
          preview: await previewMarketplaceBundle(
            cwd,
            provider.config,
            artifact,
          ),
        })
        return true
      }
      if (req.method === 'DELETE' && action === 'uninstall') {
        const uninstalled = await uninstallMarketplaceArtifact(
          cwd,
          provider.config.id,
          kind,
          id,
        )
        sendJSON(res, 200, { uninstalled })
        return true
      }

      sendJSON(res, 405, { error: 'Method not allowed' })
      return true
    } catch (error) {
      const status = error instanceof MarketplaceError ? error.statusCode : 500
      sendJSON(res, status, {
        error: error instanceof Error ? error.message : String(error),
      })
      return true
    }
  }
}
