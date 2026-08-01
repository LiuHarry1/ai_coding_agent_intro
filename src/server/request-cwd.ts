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

/**
 * Settings / MCP / LSP status: optional ?workspace= in non-SSO mode.
 * Unlike chat file IO, remote SSH cwds are absolute POSIX paths that do not
 * exist on the control-plane machine — keep them as-is so status can match
 * the open Worker runtime.
 */
export function resolveSettingsRequestCwd(
  req: IncomingMessage,
  url?: string | null,
): string {
  const pinned = (req as AuthedRequest).userWorkspace
  if (isAuthEnabled() && pinned) return pinned

  const query = new URLSearchParams(url?.split('?')[1] ?? '')
  const workspace = query.get('workspace')
  if (typeof workspace === 'string' && workspace.length > 0) {
    const looksAbsolute =
      workspace.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(workspace)
    if (looksAbsolute) {
      const localResolved = path.resolve(workspace)
      if (fs.existsSync(localResolved)) return localResolved
      return workspace.replace(/\\/g, '/').replace(/\/$/, '') || workspace
    }
    const resolved = path.resolve(workspace)
    if (fs.existsSync(resolved)) return resolved
  }

  return getDefaultWorkspace()
}
