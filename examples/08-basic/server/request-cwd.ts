import * as fs from 'fs'
import * as path from 'path'
import type { IncomingMessage } from 'http'
import { getDefaultWorkspace } from '../core/workspace.js'
import { isAuthEnabled, type AuthedRequest } from './auth/identity.js'

/**
 * Resolve the workspace directory for an HTTP request.
 * SSO: pinned userWorkspace wins; client workspace is ignored.
 * Legacy: client workspace when it exists, else server default.
 */
export function resolveRequestCwd(
  req: IncomingMessage,
  clientWorkspace?: unknown,
): string {
  const pinned = (req as AuthedRequest).userWorkspace
  if (isAuthEnabled() && pinned) return pinned

  if (typeof clientWorkspace === 'string' && clientWorkspace.length > 0) {
    const resolved = path.resolve(clientWorkspace)
    if (fs.existsSync(resolved)) return resolved
  }

  return getDefaultWorkspace()
}

/** Settings/MCP routes: optional ?workspace= in non-SSO mode. */
export function resolveSettingsRequestCwd(
  req: IncomingMessage,
  url?: string | null,
): string {
  const query = new URLSearchParams(url?.split('?')[1] ?? '')
  return resolveRequestCwd(req, query.get('workspace'))
}
